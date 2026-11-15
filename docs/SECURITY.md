# Security

Status: Phase 1. Covers authentication, authorization, sessions, MFA, API keys, secrets at
rest and the audit trail. Spec sections 8.3, 8.4 and 11.

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
- Authentication: parse, look up by `key_id`, `timingSafeEqual` on the hashes, refuse a
  prefix environment that differs from the stored one, revoked or expired keys, and
  clients outside the IP allowlist. Client IPs come from `TRUST_PROXY` CIDRs only.
- Live keys need an `active` merchant. Roll creates a successor and stops the old key after
  0 to 168 hours; a key can be rolled once. Revocation is immediate (no cache yet).
- Phase 5 adds the Redis cache, request signing, rate limits and scope enforcement on
  money routes.

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
