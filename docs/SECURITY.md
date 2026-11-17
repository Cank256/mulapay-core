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

## Support and operations (Phase 8)

- **Permissions.** Staff: `support:read|work|resolve`, `incidents:read|manage`, `ops:read|manage|approve`,
  `reports:platform`, `notification_templates:manage`. Merchant: `complaints:read|write`, `reports:read|create`,
  `analytics:read`. `super_admin` holds all staff ones. `operations` holds `support:read|work`, `incidents:*`,
  `ops:*` and `reports:platform`; `support_agent` the three `support:*` and `incidents:read`; `compliance` reads support
  and incidents and holds `reports:platform`; `auditor` reads support, incidents and ops and holds `reports:platform`. Merchant
  owner, admin and finance get all five; developer gets `reports:read` and `analytics:read`; support gets the complaint pair;
  viewer gets the three reads. Every role with `reports:platform` also holds `audit_logs:read`, `ledger:read` and
  `reconciliation:read`, because a platform report can contain what those permissions protect.
- **Approvals (maker-checker).** Rewinding the consumer cursor, disabling a provider that carries traffic, deleting a routing
  rule and (in production) changing a feature flag need a second person. The requester can never decide their own request: the
  service refuses (`APPROVAL_SELF_DECISION`) and a database trigger refuses a decision by the requester. Approving needs
  `ops:approve` and a recent step-up. A request expires after `APPROVAL_TTL_HOURS`; a decided request is final.
- **Step-up.** Required on: maintenance mode, feature flags, provider and routing-rule changes, queue retry, pause and
  resume, cursor rewind, approving and rejecting, and resolving a complaint or a dispute. Not required on incidents,
  broadcasts, template edits and report requests; those are audited.
- **Maintenance mode** refuses every write on every surface with `503 MAINTENANCE_MODE` and `Retry-After`, ahead of
  authentication; the switch and sign-in, refresh, MFA and step-up are the only writes that stay open, so staff can always
  turn it off. It is not a security control (reads continue).
- **Public status feed.** `GET /v1/status` is the one unauthenticated route besides health. It serves a fixed projection
  (headline, coarse impact, whitelisted component names, public updates), never internal updates, postmortems, causes,
  merchants or people. `api-key-security.int-spec.ts` fails if any other `/v1` route lacks a scope.
- **Customers' personal data.** A customer's contact on a complaint is AES-GCM encrypted, hidden from merchants, and read only
  through `GET /admin/v1/complaints/{ref}/contact`, which audits who looked. Notification addresses (SMS, push) are
  encrypted too.
- **Reports.** A merchant sees only its own reports; platform report types are refused to merchants. A download is a
  presigned GET valid 15 minutes and writes an audit row each time. The file is deleted
  after 7 days. A scheduled report goes only to members of the merchant (or staff), never to an arbitrary address.
- **Notifications.** Vendor credentials (`EMAIL_API_KEY`, `SMS_API_KEY`, `FCM_CREDENTIALS_JSON`) come from the environment. A
  delivery stores a short error code, never a vendor response.
- **Audit.** Every operational write (maintenance, flags, providers, routing rules, queues, cursor, approvals, incidents,
  complaints, disputes, notification and report actions) writes an audit row. `core_ops_actions_total` counts the operational ones.

## Phase 9 review (hardening)

Reviewed against spec section 11 and the Phase 9 checklist. "Verified" means an automated test or a
command run in this phase proves it; "read" means code review only. Findings carry a severity and
an ID that `PRODUCTION_READINESS.md` tracks to closure.

### Findings

| ID      | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-1    | **High** | `mulapay_core_rw` owns the `core` schema and every table. An owner can disable triggers, re-grant itself `UPDATE`/`DELETE` and drop tables, so the append-only ledger and audit controls (spec D5) hold against application bugs and SQL injection but not against stolen database credentials. Proven by `it.fails` tests in `database-security.int-spec.ts`.                                                                | **Open: needs an architecture decision.** Separate owner/migrator role from the application role (spec D2 says "full rights on `core`", which is the conflict). Not changed silently.                                                                                                                                                                                                                       |
| ENC-1   | **High** | Spec 11 requires a KMS-wrapped data key with a key id stored beside the ciphertext so rotation works. `FieldEncryption` uses one raw key from the environment, refuses to run with `KMS_KEY_ID` set, and rejects any value whose key id differs. A key rotation or compromise therefore makes every encrypted column (MFA secrets, webhook and signing secrets, destinations) unreadable, and there is no re-encryption tool. | **Open: architecture decision** (KMS, keyring with previous keys, re-encrypt job).                                                                                                                                                                                                                                                                                                                          |
| DB-2    | High     | A database connection that died while checked out raised an uncaught exception, and `runProcess` exits on one: a failover would have crashed every API and worker pod at once. Found by the chaos suite.                                                                                                                                                                                                                      | **Fixed** in `src/common/db/pools.ts`; regression test `pool-resilience.int-spec.ts` failed before the fix.                                                                                                                                                                                                                                                                                                 |
| DB-3    | High     | A query on a database connection that goes silent (partition, vanished host) had no client-side limit and waited for the operating system's TCP timeout, hours.                                                                                                                                                                                                                                                               | **Fixed**: `query_timeout` = `DB_STATEMENT_TIMEOUT_MS` + 2 s and a 10 s TCP keepalive delay (`src/common/db/pools.ts`); the regression test failed before. A `UnitOfWork` caller that raises its own statement timeout above the global one would be cut off by this limit; none does.                                                                                                                      |
| DB-4    | High     | drizzle-orm 0.45.4's `transaction()` runs `begin` outside its `try/finally`: a connection failing at `begin` was never released. One pool slot lost per failure; shutdown hung. Every write goes through `UnitOfWork`.                                                                                                                                                                                                        | **Fixed**: `runInTransaction` checks the client out and releases it in a `finally` that covers `begin`. The regression test failed before. Consider reporting upstream.                                                                                                                                                                                                                                     |
| OPS-1   | Medium   | The migration job (`node dist/db/migrate.js`) validated the whole application configuration, so a production migration job needed the JWT private key, data-encryption key, PII pepper and gateway key.                                                                                                                                                                                                                       | **Fixed**: it now reads only `DATABASE_DIRECT_URL` and `LOG_LEVEL` (`src/db/migrate-config.ts`, unit test; verified in the built image).                                                                                                                                                                                                                                                                    |
| GW-1    | Medium   | The circuit breaker (`RedisCircuitBreaker`) has no caller. Spec 6.2 wants routing to skip a provider whose breaker is open. Today settlement payouts call the gateway directly. It had no tests; the state machine and the Redis store now have.                                                                                                                                                                              | **Open**: belongs to Phase 4 routing.                                                                                                                                                                                                                                                                                                                                                                       |
| GW-2    | Low      | A gateway `401`/`403` on a payout is retried (up to 8 attempts, same `externalId`) where spec 3.5 says page on-call and do not loop. Financially safe (same key), operationally noisy.                                                                                                                                                                                                                                        | **Closed (P9-GW-2).** The submit job now fails at once and is not retried in a loop on a gateway `401`/`403`: it logs an error and raises `core_gateway_auth_rejections_total` (alert above 0). The sweep re-drives the payout with the same `externalId` once per `SETTLEMENT_RELEASE_RETRY_SECONDS` after the credentials are fixed.                                                                      |
| GW-3    | Low      | `GATEWAY_MAX_RETRIES` is validated but nothing reads it. The client makes one attempt; the caller retries with the same key.                                                                                                                                                                                                                                                                                                  | Open: remove or implement                                                                                                                                                                                                                                                                                                                                                                                   |
| PERF-1  | Medium   | Spec 9.2 rule 13 (shed non-critical reads when event-loop lag exceeds 200 ms or queue depth is high) is not implemented.                                                                                                                                                                                                                                                                                                      | Open                                                                                                                                                                                                                                                                                                                                                                                                        |
| PERF-3  | Medium   | When the connection pool is exhausted (or a statement times out under overload) the API answers `500 INTERNAL_ERROR`, not `503` with `Retry-After`, so a well-behaved client cannot tell "back off" from "broken". Seen in the soak.                                                                                                                                                                                          | **Closed (P9-PERF-3).** A connection-pool timeout, `too_many_connections`, a PgBouncer client limit and a statement timeout now answer `503 SERVICE_UNAVAILABLE` with `Retry-After: 5` (`resolveError`, `isCapacityError`). The driver message is never returned.                                                                                                                                           |
| PERF-2  | **High** | Every audited write takes `FOR UPDATE` on the single `audit_chain_head` row (4,297 calls and 14 s of lock wait in the full suite). The hash chain needs ordering, but the row lock serialises all state-changing requests platform-wide for the length of their transactions.                                                                                                                                                 | **Open: architecture decision.** Measured: with 5 ms of work after the audit row the whole platform manages about 90 audited writes per second, with 20 ms about 30, and more workers only raise latency (8 and 32 workers: 91 and 85 per second). Under the soak, 76.7% of all database time was waiting for this one row (mean 222 ms, worst 14.6 s). `test/load/audit-chain.load-spec.ts` reproduces it. |
| OBS-1   | Low      | Six of the 22 metrics in spec 10 are missing: three belong to the unbuilt gateway consumer, `core_payment_initiations_total`, `core_ledger_entries_total` and `core_merchant_available_balance_minor` are not registered. `core_ledger_posting_duration_seconds` was added in Phase 9.                                                                                                                                        | Partly fixed                                                                                                                                                                                                                                                                                                                                                                                                |
| RDY-1   | Medium   | The worker and consumer processes have no health or readiness endpoint, and the image has no `HEALTHCHECK`.                                                                                                                                                                                                                                                                                                                   | Open                                                                                                                                                                                                                                                                                                                                                                                                        |
| SEC-RLS | Info     | No row-level security anywhere. The specification does not call for it; tenant isolation is by `merchantId` in every repository method and is tested. Adding RLS would be an architecture change.                                                                                                                                                                                                                             | Not applied                                                                                                                                                                                                                                                                                                                                                                                                 |
| DEP-1   | Info     | 0 vulnerabilities in production dependencies; 31 moderate or low in development tooling only.                                                                                                                                                                                                                                                                                                                                 | See below                                                                                                                                                                                                                                                                                                                                                                                                   |

### What was checked and holds

| Area                             | Result                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database roles                   | Verified                        | Neither role can escalate (no superuser, create role, create db, replication, bypass RLS); rw has no privilege at all on gateway tables; ro has exactly `SELECT` on two gateway tables and is read-only by default; PUBLIC holds nothing; no `SECURITY DEFINER` function. `database-security.int-spec.ts` attempts each forbidden operation.                                                                                                                                                                                                                                                  |
| Append-only and financial tables | Verified                        | `UPDATE`, `DELETE`, `TRUNCATE` are refused for rw on twelve append-only tables and their default partitions; `DELETE` and `TRUNCATE` on twelve financial tables. Subject to DB-1.                                                                                                                                                                                                                                                                                                                                                                                                             |
| No Core write to a gateway table | Verified                        | rw is refused at the database; a source scan finds no write statement against them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Webhook SSRF                     | Verified (read, existing tests) | The destination is validated from the addresses DNS actually returned, at connect time, so rebinding cannot swap it; redirects are not followed; private, loopback, link-local, metadata, CGNAT, multicast, IPv4-mapped IPv6 are refused; https only; production refuses `WEBHOOK_ALLOW_PRIVATE_NETWORKS`.                                                                                                                                                                                                                                                                                    |
| Request signing, replay          | Verified (existing)             | Constant-time MAC, timestamp window, replay record written only after the MAC verifies, fails closed if Redis is down. Chaos test: with Redis down, writes are refused with a generic 503 and reads are served.                                                                                                                                                                                                                                                                                                                                                                               |
| Admin access                     | Read                            | Admin tokens without `mfa` are refused at the guard; step-up on ten admin controllers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secrets in the image             | Verified                        | The image holds no secret; it refuses to start without them and names only the missing variables. Dev dependencies are absent; no shell; runs as uid 65532; files are root-owned.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Headers                          | Verified in the running image   | HSTS, `Content-Security-Policy: default-src 'none'`, `X-Frame-Options: DENY`, `nosniff`, no `Server` header, a request id on every response.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Production configuration         | Verified in the image           | `NODE_ENV=production` refuses to start with private-network webhooks, no `TRUST_PROXY`, no Redis password, API docs on, or any missing secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Log redaction                    | Read, existing tests            | Key-based redaction covers every name in spec 10 plus `msisdn`, `cvv`, `private key`, `national id`. It matches keys, not values: free text with a secret in it is not scrubbed.                                                                                                                                                                                                                                                                                                                                                                                                              |
| Dependencies                     | Verified                        | `npm audit --omit=dev`: 0 of any severity (245 production packages). Licences: MIT 164, Apache-2.0 48, BSD-3-Clause 16, ISC 14, PSF-2.0, 0BSD, MIT-or-CC0 one each; none copyleft or unknown. Lockfile v3: every entry has a `sha512` integrity hash and resolves to `registry.npmjs.org`; no direct dependency missing. Four production packages run install scripts (`argon2`, `msgpackr-extract`, `protobufjs`, `@scarf/scarf`); the image installs with `--ignore-scripts`; `argon2` (argon2id hash and verify) and the BullMQ native extension were run inside the built image and work. |

### Dependencies not upgraded, and why

`npm audit` suggests downgrades (`drizzle-kit@0.18.1`, `testcontainers@10.10.4`, `@swc/cli@0.1.63`) for
development-only advisories; applying them would break the build and fix nothing that ships.
Outdated, all major: NestJS 11 to 12, BullMQ 5 to 6, ioredis 5 to 6, undici 7 to 8, `cron-parser`
4 to 5, `bullmq-otel` 1 to 2, TypeScript 5.9 to 7. None is security-driven. Each needs its own
change with the full regression suite. `@fastify/cors` is pinned to the exact version 11.3.0
(latest 11.4.3): unpin deliberately or note the reason. The image scan (Trivy) runs in CI only; it
was not available in this environment.
