# Architecture

Status: Phase 1 (identity and merchants) on top of the Phase 0 foundation. This document
grows with each phase. The specification is [CORE_API_BUILD_PROMPT.md](CORE_API_BUILD_PROMPT.md).
Authentication, authorization and key handling are detailed in [SECURITY.md](SECURITY.md).

## Processes

One codebase and one image; `APP_ROLE` picks the process (spec 4.1).

| Role       | Entry point            | Root module      | Does                                                             |
| ---------- | ---------------------- | ---------------- | ---------------------------------------------------------------- |
| `api`      | `src/main.api.ts`      | `AppModule`      | HTTP only. No workers, no pollers. Scales horizontally.          |
| `worker`   | `src/main.worker.ts`   | `WorkerModule`   | BullMQ workers for processors registered in `src/jobs`. No HTTP. |
| `consumer` | `src/main.consumer.ts` | `ConsumerModule` | Gateway event consumer and schedules (Phase 3). Singleton.       |

`src/main.ts` dispatches on `APP_ROLE` for `npm run start`.

Each entry point first imports `src/common/telemetry/register.ts`, which loads `.env`,
validates the configuration (exit 1 on failure) and starts tracing before `http`, `pg`,
`ioredis` and `undici` are loaded.

The consumer takes `pg_try_advisory_lock(hashtext('core:gateway-event-consumer'))` on a
dedicated direct connection before anything else, and exits with status 1 if another
instance holds it. The lock is re-verified every 5 seconds; if the connection drops or
the lock disappears, the process exits immediately (`src/common/db/advisory-lock.ts`).

## Source layout

```
src/
  main*.ts, app.module.ts, worker.module.ts, consumer.module.ts
  bootstrap/        HTTP app factory (shared by main, tests and OpenAPI export), process runner
  config/           Zod env schema, config loading
  common/
    audit/          audit writer, hash chain, @Audited, audit interceptor
    auth/           access tokens (Ed25519 JWT), argon2id, TOTP, revoked-sid store, AuthGuard
    authz/          permission catalogue, CASL ability factories, policy decorators
    context/        AsyncLocalStorage request context (requestId, surface, actor, ip, user agent)
    crypto/         SHA-256, random tokens, AES-256-GCM field encryption
    ids/            UUID v7, prefixed ULID public ids
    money/          supported currency codes (amount handling arrives in Phase 2)
    pagination/     cursor encode/decode
    clock/          injectable clock (tests use test/support/fixed-clock.ts)
    db/             pools (rw, ro, replica), UnitOfWork, singleton advisory lock
    errors/         error catalogue, AppError, envelope, exception filter
    health/         /v1/health, /v1/health/ready
    http/           request ids, envelope interceptor, response schemas, CORS, headers, hooks
    logging/        Pino root logger, redaction, Nest logger adapter
    openapi/        per-surface documents, Scalar docs
    queue/          queue catalogue, registry, worker host, dead-letter path
    redis/          ioredis connections
    telemetry/      OpenTelemetry tracing, Prometheus metrics, /metrics
  db/
    schema/         Drizzle schema, one file per domain (identity, authz, merchants, api-keys, audit)
    migrations/     drizzle-kit migrations
    bootstrap/      DBA-run SQL: roles, schema, gateway read grants
    migrator.ts     migration runner (see DATABASE.md)
  integrations/gateway/   readiness probe only (full client in Phase 3)
  modules/
    identity/       users, sessions, roles and permissions, login throttle
    merchants/      merchants, lifecycle state machine, team, invitations, onboarding
    auth/           login, MFA, refresh rotation, step-up, principal resolution, admin bootstrap
    api-keys/       issue, roll, revoke, authenticate, IP allowlists
    audit/          admin reads of the audit log, chain verification
  surfaces/         public (/v1), dashboard (/dashboard/v1), admin (/admin/v1) controllers
  scripts/          openapi-export, seed-admin
  jobs/             BullMQ processor registry (empty)
  consumers/        gateway event consumer (lock name only)
test/
  integration/      Testcontainers suites and global setup
  support/          test config, app factory, log capture, fake gateway, fixed clock
  fixtures/         stand-in gateway tables for grant tests
```

Phase 1 adds `identity`, `merchants`, `auth`, `api-keys` and `audit`. The spec's module
list has no home for users, sessions and login flows, so they live in `identity` (data) and
`auth` (flows). `auth` sits above `identity` and reads memberships through its own
repository, so `merchants` does not depend on it.

## Layering

```
controller -> application service -> domain service -> repository -> Drizzle
```

Controllers validate, authorize and map shapes. Application services own the use case
and the transaction (`UnitOfWork.run`). Domain services own invariants. Repositories own
SQL. No outbound HTTP, S3 or queue call happens inside a transaction (spec 4.3, 9.2).

## Request lifecycle (api)

1. **Request id.** `genReqId` accepts `X-Request-Id` if it matches `[A-Za-z0-9._:-]{8,128}`,
   otherwise generates a UUID. It is echoed on every response, including errors.
2. **Context.** An `onRequest` hook opens an AsyncLocalStorage context with `requestId`
   and `surface`. Every log line written during the request carries them, plus `trace_id`
   and `span_id` from the active span.
3. **Security headers and CORS.** Helmet (deny-all CSP, `X-Frame-Options: DENY`, `nosniff`,
   HSTS). CORS per surface: `/v1` allows no browser origin; `/dashboard/v1` and
   `/admin/v1` allow only `CORS_DASHBOARD_ORIGINS` and `CORS_ADMIN_ORIGINS`.
4. **Body parsing.** JSON only, 256 KB limit. Fastify's parser rejects prototype
   poisoning. Other content types get 415.
5. **Authentication and authorization.** The global `AuthGuard` (details in
   [SECURITY.md](SECURITY.md)):
   - refuses any route without a policy decorator (`@Public`, `@Authenticated`,
     `@RequirePermission`);
   - authenticates by the surface of the matched route template: API key on `/v1`,
     dashboard JWT on `/dashboard/v1`, admin JWT with MFA on `/admin/v1`;
   - checks the CASL ability, then `@RequiresStepUp`, then the closed-merchant rule;
   - audits denied writes.
6. **Validation.** Global `ZodValidationPipe` (nestjs-zod). DTOs use strict schemas.
7. **Handler.** Thin controller. The `AuditInterceptor` wraps every `@Audited` route.
8. **Envelope.** `ResponseEnvelopeInterceptor` wraps results as
   `{ success: true, data, meta: { requestId } }` unless the route is `@RawResponse()`
   (health, metrics).
9. **Serialization.** `@ApiEnvelopedResponses({ 200: schema })` turns one Zod schema into
   the Fastify response schema (fast-json-stringify, which also drops undeclared fields)
   and the OpenAPI response.
10. **Errors.** `GlobalExceptionFilter` maps everything through `error-mapper.ts` and the
    catalogue: `{ success: false, error: { code, message, details?, requestId, docUrl } }`.
    Client messages always come from the catalogue. 5xx responses never carry detail; the
    detail is logged with redaction.
11. **Completion.** One `request completed` log line (method, route template, status,
    duration) and the `core_http_request_duration_seconds` observation.

## Observability

- **Logs:** Pino JSON with gateway-compatible fields (numeric `level`, epoch `time`,
  `msg`). Every line passes through key-based redaction (`redaction.ts`, the gateway's
  approach): authorization, API keys, signatures, cookies, passwords, secrets, tokens,
  phone, msisdn, email, account numbers, PINs and card data, at any depth. Bodies are
  never logged.
- **Traces:** OpenTelemetry over OTLP/HTTP when `ENABLE_TELEMETRY=true`. HTTP in and out,
  undici (gateway calls carry `traceparent`), Postgres (no parameters), Redis (command
  name only), BullMQ via `bullmq-otel`. Probes are not traced.
- **Metrics:** `GET /metrics` with `Authorization: Bearer <METRICS_TOKEN>`, registered only
  when the token is set. Phase 0 metrics: `core_http_request_duration_seconds`,
  `core_db_pool_connections`, `core_queue_depth`, `core_queue_oldest_job_seconds`, and the
  default Node.js process metrics. Phase 1 adds `core_auth_failures_total{surface, reason}`.
  Domain metrics arrive with their phases.

## Queues

`src/common/queue/queue.definitions.ts` lists the nine queues and concurrencies from
spec 8.9 under the Redis prefix `mulapay-core`. Default job options: 5 attempts,
exponential backoff from 1 s, completed jobs kept for 24 h (max 1000), failed jobs kept
for 7 days (max 10000). Queues with a specified schedule override these in their phase.

`WorkerHost` runs one BullMQ worker per registered processor. When a job fails its last
attempt (or throws `UnrecoverableError`) it is copied to the `dead-letter` queue under the
deterministic id `{queue}.{jobId}`, so a repeated failure event cannot create a second
entry. No worker consumes `dead-letter`; it is a parking lot for operations tooling.

The api process creates Queue handles only to read depth for metrics. Nothing enqueues
from a request handler; that path is the outbox (Phase 4).

## Phase 0 decisions to confirm

These choices were made where the spec is silent or ambiguous. Each is easy to change.

- **Health response bodies** match the gateway: `{ "status": "ok" }` and
  `{ "status": "ready" | "not_ready" }`, not the success envelope. Which check failed is
  logged, not returned.
- **Gateway readiness.** A gateway that is down makes core not-ready, as section 7.4
  lists. With `GATEWAY_BASE_URL` unset (allowed outside production) the check is skipped.
- **Docs paths** are `/docs/{public|dashboard|admin}/` and `.../openapi.json`. Docs are
  refused in production until authenticated docs exist.
- **Pool sizes.** `DB_POOL_MIN`/`DB_POOL_MAX` apply to each of the rw, ro and replica
  pools; the spec defines only one pair.
- **Replica fallback.** Without `DATABASE_REPLICA_URL`, replica reads use the rw pool and a
  warning is logged.
- **Head-based sampling.** "Errors always sampled" (section 10) cannot be done by an SDK
  head sampler; it needs tail-based sampling in the collector.
- **Worker and consumer metrics.** Those processes have no HTTP listener, so their own
  metrics are not scraped yet. Queue depth is reported by the api's `/metrics`.
- **Production-required secrets.** In production, boot fails without `TRUST_PROXY`, a
  Redis password, `GATEWAY_BASE_URL`, `GATEWAY_API_KEY`, the JWT key pair and `JWT_KID`,
  `DATA_ENCRYPTION_KEY` and `PII_HMAC_PEPPER`.

## Audit trail

Every state change writes an audit row in the same transaction (`AuditService.record`).
Rows are hash-chained, `hash = sha256(prev_hash || canonical(row))`, and appended under a
row lock on `core.audit_chain_head`, which also assigns `seq` without gaps. The
`AuditInterceptor` writes a backstop row when an `@Audited` route succeeds without one,
and an `error` or `denied` row when an authenticated request fails. The guard writes
`denied` rows for writes it refuses. Unauthenticated failures are counted in
`core_auth_failures_total`, not audited, so anonymous traffic cannot make the platform
write audit rows; failed logins are audited, without the attempted email for unknown
accounts. `GET /admin/v1/audit-logs/verify` walks the chain and compares the head.

## Merchant lifecycle

`src/modules/merchants/domain/merchant-lifecycle.ts`, pure and fully unit-tested:

| Event         | From                                | To            | Actor    | Exposed in Phase 1                       |
| ------------- | ----------------------------------- | ------------- | -------- | ---------------------------------------- |
| `submit_kyc`  | `draft`                             | `pending_kyc` | merchant | no (Phase 7 KYC submit)                  |
| `approve_kyc` | `pending_kyc`                       | `active`      | system   | no (Phase 7 KYC approval)                |
| `suspend`     | `active`                            | `suspended`   | admin    | `POST /admin/v1/merchants/:ref/suspend`  |
| `activate`    | `suspended`                         | `active`      | admin    | `POST /admin/v1/merchants/:ref/activate` |
| `close`       | `draft`, `pending_kyc`, `suspended` | `closed`      | admin    | `POST /admin/v1/merchants/:ref/close`    |

Every other pair is refused with `409 MERCHANT_INVALID_TRANSITION`. A closed merchant
keeps read access only: the guard refuses every non-read permission with
`403 MERCHANT_CLOSED`. Live API keys need an `active` merchant.

## Phase 1 decisions to confirm

Choices made where the spec is silent, ambiguous or conflicts with the request. Each is
easy to change.

**Scope against the build order**

- **API keys were built in Phase 1** because the Phase 1 request asked for them; spec 14
  places them in Phase 5. Built: issue, roll with a 0 to 168 hour grace period, revoke,
  database-backed authentication (`timingSafeEqual` on SHA-256), environment check, IP
  allowlist, and `GET /v1/ping`. Still Phase 5: the Redis key cache with negative caching
  and pub/sub eviction, the batched `last_used_at` flush, request signing, rate limits
  (`rate_limit_rpm` is not accepted until it is enforced), and scope checks on real routes.
- **Key prefix.** Spec 4.2 says `sk_`; sections 2 and 6.11 say `mp_{live|test}_{keyId}_{secret}`.
  The `mp_` format is used.
- **Not built (they need email delivery, Phase 8):** `forgot-password`, `reset-password`,
  `verify-email`. Until then registration does not verify the email,
  `EMAIL_ALREADY_REGISTERED` reveals that an email is registered, and an invitation's
  token is returned once in the creation response for the inviter to pass on.
- **Not built (owned by later phases):** merchant settings, limits and fee plan views,
  admin limits, fee plan, balances, activity and impersonation, audit export.
- **Staff management API (`/admin/v1/staff`) is not built.** The admin catalogue has no
  MFA enrollment route, so staff are created by `npm run seed:admin`, which enrolls TOTP at
  creation. "Prints a one-time password" is read as "shown once"; there is no
  forced-change flow because the catalogue has no password-change route.

**Authorization and sessions**

- **Staff roles** are not named by the spec: `super_admin`, `operations`, `compliance`,
  `support_agent`, `auditor` (matrix in [SECURITY.md](SECURITY.md)).
- **Roles and permissions are seeded by migration 0001**, not `src/db/seeds`: a migration
  runs once per environment, so admin edits are never overwritten, and later phases grant
  their new permissions in the migration that adds them.
- **Permissions are read from the database on every request**, not from the token's
  `roles` claim. The principal is re-resolved per request (one indexed query), so a role
  change, removal or disabled user takes effect on the next request.
- **Step-up.** The dashboard catalogue has no step-up route, so dashboard step-up means a
  login within `STEP_UP_WINDOW_SECONDS`. Step-up is also required for admin lifecycle
  actions and role edits, which the spec does not mandate.
- **MFA enrollment** uses one route twice: without a code it starts, with a code it
  confirms.
- **A dashboard session is bound to one merchant** at login (`merchant` in the body,
  default the earliest membership). Switching merchants is a new login.
- **Refresh families have an absolute lifetime** of `REFRESH_TOKEN_TTL` from login.
- **Key rotation.** There is no `JWT_PREVIOUS_KID`; a token whose `kid` is not `JWT_KID`
  verifies against `JWT_PREVIOUS_PUBLIC_KEY`.
- **Closing an account** is admin-only. Spec 6.10 also says only the owner can close the
  account, but lists no dashboard route for it.

**Data**

- **Close needs a zero balance, but no ledger exists yet.** `MERCHANT_BALANCE_CHECK` is
  bound to `NoLedgerYetBalanceCheck`, which reports zero because there are no balance
  tables. **Phase 2 must bind a ledger-backed check.** The write-off path needs the
  approvals workflow (Phase 4).
- **`audit_logs.seq`** is assigned from the chain head (gap-free) rather than a
  `bigserial` sequence; `ip` is `text` so the hashed value round-trips exactly.
- **Audit write throughput.** The chain-head lock serialises audit appends across the
  platform. Re-check under the Phase 9 load tests.
- **Audit partitions** exist from 2025-01 to three months after the migration ran, plus a
  default partition. Phase 9 partition automation must create months ahead and move any
  default-partition rows first.
- **`users.phone`** is not created: nothing uses it yet and it is PII.
- **KMS-wrapped data keys** are not supported; with `KMS_KEY_ID` set, encryption refuses
  to run rather than treat the wrapped key as raw.
- **citext** is installed by the bootstrap SQL (mulapay_core_rw cannot create
  extensions). Existing local volumes need the bootstrap re-run or `docker compose down -v`.
- **Login rate limits** (spec 8.5) arrive with Phase 5; the progressive lockout of 8.3 is
  in place.
