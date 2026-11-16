# Security

Status: Phase 5. Covers authentication, authorization, sessions, MFA, API keys and their
cache, request signing, rate limits, webhooks, secrets at rest and the audit trail. Spec
sections 6.11, 8.3, 8.4, 8.5 and 11.

## Surfaces and authentication

| Surface         | Credential                                               | Accepted by                                  |
| --------------- | -------------------------------------------------------- | -------------------------------------------- |
| `/v1`           | `Authorization: Bearer mp_{live\|test}_{keyId}_{secret}` | `DbApiKeyAuthenticator`                      |
| `/dashboard/v1` | `Authorization: Bearer <JWT aud=dashboard>`              | `AccessTokenService` + `DbPrincipalResolver` |
| `/admin/v1`     | `Authorization: Bearer <JWT aud=admin, mfa=true>`        | same, plus the MFA claim check               |

The `AuthGuard` picks the method from the matched route template, never the raw URL.
A dashboard token is refused on admin routes and vice versa (`aud`), and neither is
accepted on `/v1`.

## Access tokens

- EdDSA (Ed25519) JWT, `kid` in the header, `ACCESS_TOKEN_TTL` (default 600 s).
- Claims: `iss`, `aud`, `sub` (user ref), `type`, `merchantId` (merchant ref or null),
  `roles`, `sid` (session ref), `mfa`, `amr` (`pwd`, `otp`), `auth_time`, `iat`, `exp`,
  `jti`. Only public refs appear in tokens.
- Verification accepts exactly `alg: EdDSA`, a strict claim set, the expected `iss` and
  `aud`, an unexpired `exp` and an `iat` no more than 60 s ahead. Then one Redis lookup of
  the revoked `sid`, then a database lookup of the user and membership.
- Rotation: `JWT_PUBLIC_KEY` verifies tokens whose `kid` is `JWT_KID`;
  `JWT_PREVIOUS_PUBLIC_KEY`, when set, verifies any other `kid`. Deploy the new key pair
  with the old public key as previous, wait one `ACCESS_TOKEN_TTL`, then remove it.
- Without keys (allowed outside production) logins fail with 503.

## Sessions and refresh tokens

- A session is a family of `core.sessions` rows, one per refresh token. The family id is
  the public session id (`ses_...`) and the JWT `sid`.
- Refresh tokens are 32 random bytes; only SHA-256 is stored. Every refresh retires the
  presented row and inserts a successor. Presenting a retired token revokes the whole
  family, writes an `auth.refresh_token_reused` audit row and logs a security alert.
- The family's absolute lifetime is `REFRESH_TOKEN_TTL` from login.
- Cookies: `mp_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/{dashboard|admin}/v1/auth`)
  and `mp_csrf` (same, readable). Refresh requires `X-CSRF-Token` equal to `mp_csrf`
  (double submit); the token is also returned in the login body for cross-origin clients.
- Logout and `DELETE /dashboard/v1/auth/sessions/:id` revoke the family in Postgres and
  add the `sid` to Redis (`auth:revoked-sid:{sid}`, TTL = access TTL + 60 s), so the
  access token stops working at once. If Redis is unreachable the guard answers 503.

## Login protection

- argon2id, `memoryCost 19456, timeCost 2, parallelism 1`. Passwords 12 to 128 characters.
- Unknown email, wrong password, disabled account and an account of the other surface's
  type all return `401 INVALID_CREDENTIALS` after a full argon2 verification.
- Progressive lockout per account (keyed by a hash of the normalised email, existing or
  not) and per IP: from the 5th failure, 1, 2, 5, 15, then 60 minutes, as
  `429 TOO_MANY_LOGIN_ATTEMPTS` with `Retry-After`. Counters reset 24 h after the last
  failure; a success clears the account counter only. Wrong MFA codes count.
- Lock state lives in Redis and is mirrored to `users.failed_login_count` and
  `users.locked_until` for known accounts. Without Redis, logins fail with 503.

## MFA

- TOTP (RFC 6238, 6 digits, 30 s, one step of drift), otplib.
- Secrets are AES-256-GCM encrypted (`users.mfa_secret_enc`), bound to the user id as
  associated data. A code is accepted once: `users.mfa_last_used_step` is advanced with a
  conditional update, so concurrent requests cannot reuse a code.
- Login challenges are opaque 32-byte tokens in Redis for 5 minutes, single use,
  discarded after 5 wrong codes, and bound to the surface.
- Staff: always required. A staff account without MFA cannot log in, and admin tokens
  without `mfa: true` are refused. Staff MFA is enrolled by `npm run seed:admin`.
- Merchant users: optional. `POST /dashboard/v1/auth/mfa/enroll` without a code starts
  enrollment, with a code confirms it. Disabling needs step-up and a current code.

## Step-up

`@RequiresStepUp()` routes need `amr` non-empty and `auth_time` within
`STEP_UP_WINDOW_SECONDS` (default 300), else `403 STEP_UP_REQUIRED`. Staff renew it with
`POST /admin/v1/auth/step-up` (password and TOTP). Dashboard users renew it by logging in.

Step-up routes: `POST /dashboard/v1/auth/mfa/disable`, `POST /admin/v1/merchants/:ref/{activate,suspend,close}`,
`PATCH /admin/v1/roles/:key`.

## Authorization

- Every route carries `@Public()`, `@Authenticated()` or `@RequirePermission(p)`. A route
  without one is refused, and `test/integration/security.int-spec.ts` fails if any
  registered route lacks one, lacks a response schema, or is a write without `@Audited`.
- One CASL ability factory per actor type (`src/common/authz/ability.ts`). Permissions are
  `subject:action`; `manage` implies every action on the subject. A permission of another
  actor type is dropped, never granted.
- Role permissions come from `core.role_permissions` on each request (30 s in-process
  cache, cleared on edit and by Redis pub/sub `core:authz:roles-changed`).
- Merchant scoping is not a CASL concern: every repository method on a merchant-scoped
  table takes `merchantId`, and the merchant always comes from the session or the key,
  never from the request. Another merchant's resource is a 404, identical to a missing one.
- Closed merchants: every non-read permission is refused with `403 MERCHANT_CLOSED`.

### Merchant roles (spec 6.10)

| Permission          | owner | admin | developer | finance | support | viewer |
| ------------------- | :---: | :---: | :-------: | :-----: | :-----: | :----: |
| `merchant:read`     |   x   |   x   |     x     |    x    |    x    |   x    |
| `merchant:update`   |   x   |   x   |           |         |         |        |
| `team:read`         |   x   |   x   |     x     |    x    |    x    |   x    |
| `team:manage`       |   x   |   x   |           |         |         |        |
| `api_keys:read`     |   x   |   x   |     x     |         |         |        |
| `api_keys:manage`   |   x   |   x   |     x     |         |         |        |
| `payments:read`     |   x   |   x   |     x     |    x    |    x    |   x    |
| `transactions:read` |   x   |   x   |     x     |    x    |    x    |   x    |
| `webhooks:read`     |   x   |   x   |     x     |         |    x    |   x    |
| `webhooks:manage`   |   x   |   x   |     x     |         |         |        |
| `request_logs:read` |   x   |   x   |     x     |         |    x    |        |

Rules in code, independent of the matrix: only the owner transfers ownership; the owner
cannot be removed or demoted except by transferring; exactly one active owner per
merchant (unique index).

### Staff roles

| Permission            | super_admin | operations | compliance | support_agent | auditor |
| --------------------- | :---------: | :--------: | :--------: | :-----------: | :-----: |
| `merchants:read`      |      x      |     x      |     x      |       x       |    x    |
| `merchants:create`    |      x      |     x      |            |               |         |
| `merchants:update`    |      x      |     x      |            |               |         |
| `merchants:lifecycle` |      x      |     x      |     x      |               |         |
| `audit_logs:read`     |      x      |     x      |     x      |               |    x    |
| `audit_logs:verify`   |      x      |            |     x      |               |    x    |
| `roles:read`          |      x      |            |            |               |    x    |
| `roles:manage`        |      x      |            |            |               |         |

`super_admin` cannot lose `roles:manage`. Admins edit role permissions with
`PATCH /admin/v1/roles/:key`; the set of roles is fixed.

## API keys

- `mp_{live|test}_{keyId}_{secret}`: `keyId` 16 chars `[a-z0-9]`, secret 32 random bytes
  (hex). Only `SHA-256(secret)` is stored; the full key is returned once, by create or roll.
- Authentication (`DbApiKeyAuthenticator`): parse, find by `key_id` (Redis, then Postgres),
  `timingSafeEqual` on the hashes, refuse a prefix environment that differs from the stored
  one, revoked or expired keys (judged on every request), and clients outside the IP
  allowlist. Every refusal is the same `401`, so nothing distinguishes a wrong secret from a
  revoked key or a blocked address.
- Live keys need an `active` merchant. Roll creates a successor and stops the old key after
  0 to 168 hours; a key can be rolled once.
- **Cache** (`ApiKeyCache`, spec 8.3): `apikey:{keyId}` 60 s, `apikey:neg:{keyId}` 30 s for
  unknown ids. Revocation, a roll, and a merchant suspension or closure evict through
  Redis _eviction markers_ stamped with the Redis clock. Every entry records the Redis time at
  which its database read began, and is honoured only if that is after the latest marker, so a
  reader that read the old row before the change and cached it after the delete is still
  discarded. If Redis cannot be reached at eviction time the change is committed anyway and
  cached copies lapse within 60 s (logged at error level). A status or key change made
  directly in SQL, outside the services, is not evicted: operators must go through the
  services (or call `ApiKeyCache.evictMerchant`).
- `last_used_at` is a Redis sorted set flushed every 10 s by the worker, never written on the
  request path.
- **Client address.** `request.ip` comes from Fastify `trustProxy` (`TRUST_PROXY` CIDRs) only.
  With no trusted proxy, forwarding headers are ignored entirely; with one, the address is the
  rightmost one the proxy chain did not itself append, so addresses a client writes into
  `X-Forwarded-For` ahead of it are ignored. IPv4-mapped IPv6 and zone ids are normalised
  before matching an allowlist. Tests: `api-key-security.int-spec.ts`.

## Scopes

`API_KEY_SCOPES` (16) gate `/v1` routes through `@RequirePermission(scope)` and the key's CASL
ability (`apiKeyAbility`); an unknown scope can neither be issued (400) nor granted (dropped).
`api-key-security.int-spec.ts` asserts that every `/v1` route except `ping` requires a defined
scope, that each route refuses a valid key without its scope (403) and that read scopes do not
imply write scopes. A dashboard or admin token is never accepted on `/v1`.

## Request signing (spec 6.11)

- Headers `X-MulaPay-Timestamp` and `X-MulaPay-Signature: v1=<hex>`; HMAC-SHA256 of
  `timestamp.METHOD.path.sha256(rawBody)` keyed with the key's **signing secret**.
- The spec names the headers and the signing string but not the key. It cannot be the API key
  secret (the server stores only its hash, and the HMAC must be recomputed), and using the hash
  as the key would make the signature derivable from the bearer secret and add nothing. Each key
  therefore gets a separate `mpsig_` secret, shown once and stored AES-256-GCM encrypted bound to
  the key (`api_keys.signing_secret_enc`). **Decision to confirm.**
- `path` is the request target as sent, query string included. The spec says "path"; including
  the query closes tampering with filters and is what a client library naturally has.
  **Decision to confirm.**
- Required for keys with `signing_required`, which is forced on for every live key holding
  `payouts:write`; such a key must sign every request. A signature that is present is always
  verified. Raw body bytes are captured by a wrapper around Fastify's JSON parser
  (`raw-body.ts`), which keeps its prototype-poisoning protection.
- Order of checks: both headers, a signing secret, timestamp (digits only, within
  `SIGNATURE_TOLERANCE_SECONDS`, default 300, both directions), header shape, constant-time MAC
  comparison, and only then replay (`SET sigreplay:{key}:{mac} NX EX 2 x tolerance + 5`). The
  record is written after the MAC verifies, so forged signatures cannot burn real ones, and it
  lives for twice the tolerance because a timestamp is acceptable for that long. If Redis is
  down the request gets `503`: no signed request is accepted without replay protection.
- A consequence: two identical requests signed in the same second have the same signature, so
  the second is refused as a replay. Clients retry with a fresh timestamp.

## Rate limiting (spec 8.5)

One Lua script per request evaluates all limits atomically against Redis time: the key's read
or write sliding window, the merchant's payout window (routes needing `payouts:write`) and the
key's burst token bucket (20 / 10 per s). A refused request consumes nothing from any limit.
Limits are keyed by API key and merchant, never by IP or path, so spoofed addresses and
forwarding headers, URL spelling and query strings buy nothing. Requests refused for a missing
scope are counted. Failed authentications are limited per client (`RATE_LIMIT_AUTH_FAILURE_PER_MIN`,
per /64 for IPv6): a client over the limit gets `429` before its credential is examined. Redis
down: reads pass, writes get `503`. Keys carry TTLs (window length, or twice the refill time).

## Webhooks

- Merchant-controlled URLs are an SSRF vector, so they are checked at registration **and** at
  delivery: `https` only (plain `http` only where `WEBHOOK_ALLOW_PRIVATE_NETWORKS` allows, which
  production refuses), no credentials or fragment, and the connection address is validated
  inside the socket `lookup` from the very addresses DNS returned, so rebinding cannot swap a
  public name for an internal address. Loopback, private, link-local (including the cloud
  metadata address), carrier-grade NAT, multicast, reserved and mapped-IPv4 ranges are refused.
  Redirects are never followed. 10 s timeout. 1 KiB of the response kept, control characters
  removed. Failures are stored as short codes, never the network error.
- Signing: `MulaPay-Signature: t=<unix>,v1=<hmac("t.payload")>`; two `v1` during a rotation's
  grace period. `t` is covered by the MAC and fresh on every attempt; `MulaPay-Event-Id` is stable
  across attempts and replays. Endpoint secrets are encrypted at rest and shown once.
- Delivery is at least once with effect once per attempt: a lease on the delivery row plus a
  conditional update (`attempt` and `status = 'pending'`) mean a duplicate job sends nothing. A
  delivery that left `pending` is final in the database, so a delivered event cannot be re-sent
  by editing a row; a replay is a new row.
- Logs carry refs, status and timings, never the URL, payload, secret or response body.

## Sandbox

Test keys never reach the gateway: there is no gateway client yet, the simulator and the payment
code import nothing from `integrations/gateway` (`sandbox-boundary.spec.ts`), and
`assertGatewayEligible(environment)` is what the Phase 3 client must call before any request.
The simulator refuses a payment of any other environment.

## Secrets at rest

- `DATA_ENCRYPTION_KEY` (32 bytes, base64) encrypts with AES-256-GCM:
  `v1.{keyId}.{iv}.{tag}.{ciphertext}`, with a context string as associated data. `keyId`
  is the first 12 hex characters of the key's SHA-256. KMS-wrapped keys are not
  supported yet.
- Stored hashes: passwords (argon2id), refresh tokens, invitation tokens, API key secrets
  (SHA-256). None is ever returned or logged.

## Logs

Pino redaction by key name covers tokens, passwords, secrets, API keys, cookies,
signatures and emails at any depth. Drizzle query errors carry SQL parameter values in
their message, so `toLoggableError` drops the SQL and parameters. The security
integration suite asserts that passwords, API keys, access and refresh tokens, TOTP
secrets and emails never appear in any log line.

## Admin bootstrap

```bash
npm run seed:admin -- --email ops@mulapay.com --name "Ops Admin" [--role super_admin]
```

Needs `DATABASE_URL` and `DATA_ENCRYPTION_KEY`. Prints the password, TOTP secret and
otpauth URI once, to stdout. Writes a `staff.bootstrapped` audit row with actor `system`.

## Payments, transactions and idempotency

- **Scopes.** The `/v1` payment routes need `payments:read` or `payments:write`; payment
  links and checkout sessions use the same two; transactions need `transactions:read`. The
  dashboard lists need the merchant permissions `payments:read` and `transactions:read`
  (every team role has them).
- **Scope of data.** Every repository method takes a `MerchantScope` (merchant and
  environment) built from the principal, never from the request. A payment, link, session or
  transaction of another merchant or environment is `404`. A test key cannot read live data.
- **Idempotency** (spec 8.2): `Idempotency-Key` is required on every route that creates a
  payment, link or checkout session. Postgres decides, in the transaction of the work; the
  Redis marker is only an early check. Stored responses never contain a client secret.
- **Client secrets.** A checkout session's secret is `{sessionRef}_secret_{random}`, stored
  only as SHA-256, compared in constant time, shown once. A wrong secret and an unknown
  session are both `404`.
- **Phone numbers** are AES-GCM encrypted (`payments.msisdn:{paymentRef}` as associated data);
  only the last four digits are stored in clear, and only they are returned.
- **Provider detail.** Failure reasons, gateway operation and reference ids and rejected
  events are stored but never returned to merchants.
- **Audit.** Merchant-initiated changes (create, cancel, link and session changes) write an
  audit row in their transaction. Status changes driven by the gateway, the chase job or the
  expiry sweep are recorded in `transaction_events` (which is append-only), not in the audit
  chain, to keep the chain-head lock off the event path.

## Compliance (Phase 7)

- **Permissions.** Merchant: `kyc:view`, `kyc:submit`, `disputes:read`, `disputes:write` (viewer and
  support get the two read permissions; owner and admin get all four; finance gets `kyc:view` and
  both dispute permissions). Staff: `kyc:read|review|approve|view_documents|requirements`,
  `aml:read|work|rules|blocklist|block|str`, `chargebacks:read|work|resolve`. `compliance` and
  `super_admin` hold all of them. `operations`, `support_agent` and `auditor` hold read-only subsets
  (operations may also work chargebacks).
- **Maker-checker.** A reviewer who verified a document or recorded a check in the current
  submission cannot approve that submission.
- **Documents.** The browser uploads straight to object storage with a presigned PUT that signs the
  content type, length, SHA-256 and the server-side encryption header. Confirmation reads the first
  16 bytes and checks them against PDF, JPEG or PNG magic numbers, never the extension; a refused
  object is deleted. Core never relays file contents. A staff view is a short-lived presigned GET
  and writes an audit row every time. `S3_SERVER_SIDE_ENCRYPTION` is required in production.
- **Personal data.** TIN, director and UBO names, dates of birth and ID numbers are AES-GCM
  encrypted (contexts in `docs/DATABASE.md`); blocklist and screening lookups use an HMAC of the
  value (`PiiHasher`, keyed by `PII_HMAC_PEPPER`, required in production), so the database and
  Redis hold a digest, not the identifier.
- **Screening provider.** Fails closed: with no usable provider the merchant stays unscreened and
  cannot activate. A confirmed sanctions or PEP match blocks activation, opens an AML case and is audited.
- **Tipping off.** AML alerts, cases, screenings and block reasons are admin-only routes. See
  `docs/ARCHITECTURE.md` ("Phase 7 decisions to confirm") for what a merchant is told.
- **Audit.** Every KYC, screening, rule, alert, case, STR, blocklist, block and dispute change writes
  an audit row in the transaction of the change.
