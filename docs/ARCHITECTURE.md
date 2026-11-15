# Architecture

Status: Phase 2 ledger core (without holds) on top of Phases 0 and 1, plus the payment and
transaction domain without the Provider Gateway. This document
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
    idempotency/    Idempotency-Key interceptor, service, Redis marker, canonical JSON
    ids/            UUID v7, prefixed ULID public ids
    money/          supported currencies and exponents, bigint minor-unit helpers
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
    schema/         Drizzle schema, one file per domain (identity, authz, merchants, api-keys, audit, ledger)
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
    accounts/       chart of accounts: codes, merchant and bank account opening, code resolution
    balances/       posted balances per (account, currency), ledger-backed merchant close check
    ledger/         postEntry, reverseEntry, integrity validation, trial balance
    payments/       payment state machine and lifecycle, payment links, checkout sessions, expiry
    transactions/   the transaction read model: queries, event log, timeline
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

## Ledger (Phase 2)

Double-entry, append-only, in bigint minor units (spec 5.3 to 5.5, 6.6, decision D5).
Database-level invariants are listed in [DATABASE.md](DATABASE.md); every one is also
checked in the application first, so a bad posting fails with a catalogue error before
anything is written.

**Write path.** `PostingService.postEntry(tx, input)` is the only way into the journal
(enforced by `ledger-boundary.spec.ts`). It runs in the caller's transaction, so a posting
commits or rolls back with the business change that caused it:

1. `validatePosting` (pure): 2 to 100 lines, positive bigint amounts, debits equal
   credits, supported currency, valid account codes, sha256 idempotency key.
2. `pg_advisory_xact_lock` on the idempotency key, then a registry lookup. The same
   posting again returns the original entry (`replayed: true`); a different posting
   under the key is `LEDGER_IDEMPOTENCY_CONFLICT`.
3. Resolve account codes in the posting's environment; refuse missing, inactive,
   wrong-currency and other-merchant accounts.
4. Lock the affected `account_balances` rows in ascending account id order (rule 8).
5. Refuse a posting that lowers a merchant payable or reserve account below zero
   (`INSUFFICIENT_BALANCE`) unless the caller sets `allowNegativeMerchantBalance`.
6. Insert the entry and its lines. Triggers register the key, check each line, apply it
   to `account_balances`, and assert the entry balances at commit.

Callers use READ COMMITTED (the UnitOfWork default) so that a posting that waited on the
key lock sees the entry the other transaction committed.

**Reversal.** `ReversalService.reverseEntry(tx, { entry, reason, createdBy })` posts the
original's lines with directions flipped, `source = 'reversal'`, `source_id` = the
original's ref and `reverses_entry_id` set. Its key is `sha256('reversal:' + originalId)`,
so asking twice returns the same reversal. A reversal cannot be reversed.

**Outcomes.** Success: entry posted, balances moved, same transaction. Failure:
nothing written; the error is a catalogue code. Duplicate: the original entry is
returned and nothing moves. Ambiguous outcomes do not exist inside the ledger (it is one
database transaction); ambiguity about external money is handled upstream, which posts
nothing until an outcome is terminal (spec 5.5).

**Integrity.** `LedgerIntegrityService.check({ from?, to? })` reads, in one REPEATABLE READ
transaction: entries in the window (default 90 days) that do not balance, have fewer
than two lines or a foreign currency; (account, currency) pairs where `account_balances`
disagrees with the sum of lines (full recompute); non-zero suspense; merchant accounts in
a debit position; and environment/currency totals whose debits differ from credits. A
failing report is logged at error level with counts only. `trialBalance(env, currency)`
lists every account with a balance.

**Chart of accounts.** Spec 5.4, in `accounts/domain/chart-of-accounts.ts` and repeated as
CHECK constraints. Accounts exist per environment and hold any currency unless
`currency` is set. Merchant payable and reserve accounts are opened in both environments
when a merchant is created (admin create and self-registration).

## Payments and transactions

Built from spec 6.1, 6.5, 8.2 and 5.2, **without the Provider Gateway**. Nothing here calls
it; a payment is created in `created` and its lifecycle is driven by events that the
Phase 3 consumer and Phase 4 chase job will feed to `PaymentLifecycleService`
([GATEWAY_INTEGRATION.md](GATEWAY_INTEGRATION.md) lists the contract).

**State machine** (`payments/domain/payment-state-machine.ts`, pure, repeated in Postgres):

| From              | To                                                        |
| ----------------- | --------------------------------------------------------- |
| `created`         | `requires_action`, `processing`, `cancelled`_, `expired`_ |
| `requires_action` | `processing`, `cancelled`                                 |
| `processing`      | `succeeded`, `failed`, `expired`                          |
| terminal          | nothing                                                   |

\* not in the spec diagram; see the decisions below. `succeeded`, `failed`, `cancelled` and
`expired` are terminal. "Unknown" is not a status: an ambiguous outcome is `processing` with
`outcome_unknown = true`, and nothing posts.

**One write path.** `PaymentLifecycleService.apply(tx, paymentId, event)` is the only code
that changes a payment's status. Per payment it serialises (locks session, payment,
transaction, then ledger accounts), dedupes on the event key, decides with the state machine,
verifies a success against the recorded amount, currency, provider and identifiers, writes the
payment, the transaction and a `transaction_events` row together, posts the collection to the
ledger on success, and moves the checkout session. A refused event (terminal state, illegal
move, mismatch) is recorded with its reason and returned, not thrown, so the consumer can
commit its cursor. Failure, expiry and cancellation post nothing.

| Operation                      | Success                  | Failure                      | Ambiguous                       | Duplicate                        | Reversal                          |
| ------------------------------ | ------------------------ | ---------------------------- | ------------------------------- | -------------------------------- | --------------------------------- |
| Create payment                 | `created`, one event row | nothing written              | n/a (no external call)          | same key: stored response        | cancel or expire                  |
| `succeeded` event              | status, entry, one tx    | whole transaction rolls back | `processing` + flag, no posting | `duplicate` or `noop`, one entry | ledger reversal (Phase 4 refunds) |
| `failed`/`expired`/`cancelled` | terminal, no posting     | rolled back                  | n/a                             | `duplicate` or `noop`            | none                              |
| Late or conflicting event      | `rejected`, recorded     | n/a                          | n/a                             | `duplicate` of the rejection     | reconciliation (Phase 6)          |

**Idempotency** (`common/idempotency`, spec 8.2). `@Idempotent('payments.create')` reads and
validates `Idempotency-Key`, fingerprints `sha256(canonicalJson(body) + method + path)`, and
the service claims the key, runs the work, stores the response and writes the audit row in one
transaction. A repeat returns the stored response with `Idempotency-Replayed: true`; another
body is `409 IDEMPOTENCY_KEY_REUSED`; a request that finds the first still running waits up to
2 s on the unique index and then answers `409 REQUEST_IN_PROGRESS` with `Retry-After: 2`. A
request that fails leaves nothing behind, so a corrected request may reuse its key.

**References.** `pay_`, `txn_`, `pl_`, `cs_` plus a ULID. The collection `externalId` is the
payment ref (spec 3.4), stored on the transaction and unique in the registry.

**Routes.** `/v1`: payments (create, list, get, cancel, timeline), payment links (create,
list, get, update, deactivate), checkout sessions (create, get, expire), transactions (list,
get). `/dashboard/v1`: `GET /payments`, `GET /transactions` with `?environment=` (default
`live`). Amounts in responses are strings of minor units; requests take a digit string or a
safe JSON integer.

## Payments and transactions: decisions to confirm

**Scope against the build order**

- **Built ahead of its phase.** Spec 14 puts transactions, payments and the idempotency
  interceptor in Phase 4, after the gateway integration (Phase 3) and the rest of Phase 2.
  They were built now on request, without the gateway. Phase 2 (holds, available balance,
  admin ledger routes) is still incomplete, and the Phase 2 work is not committed yet.
- **Not built:** merchant limits and AML pre-checks (their tables do not exist), routing and
  provider selection (a pinned provider is stored, not honoured), `GET /v1/payment-methods`,
  merchant events, webhooks and the outbox (transitions are in `transaction_events`),
  releasing holds (payments take none), the customer filter and free-text search of spec 6.5
  (`reference` matches `ref`, the external id or the provider id exactly), admin
  `/admin/v1/transactions`, a scheduler for the expiry sweep. Limits and AML pre-checks must
  exist before payments are submitted to a provider.
- **No HTTP route for first use of a link or session.** The spec lists no unauthenticated
  hosted-checkout surface, so how a payer reaches a link (slug) or a session (client secret)
  is undecided. `PaymentLinksService.redeemBySlug` and `CheckoutSessionsService.startPayment`
  are built and tested; adding a route is a controller away.

**State machine** (needs your confirmation; AGENTS.md says not to change transitions silently)

- **Two edges are added to the spec diagram:** `created -> cancelled` and `created -> expired`,
  for a payment never sent to a provider. Without them a never-submitted payment, or one
  whose checkout session lapses, could never leave `created`. Remove them in
  `payment-state-machine.ts`, `core.payment_transition_allowed` and the two tests.
- **Gaps left refused, not guessed:** a gateway `expired`, `failed` or `succeeded` for a
  payment in `requires_action`, and `cancelled` for one in `processing` (spec 3.7 maps those
  statuses but the diagram has no such edges). They come back as `rejected:
invalid_transition` and go to reconciliation. `requires_action` cannot occur until the
  gateway integration exists.
- **Cancelling from `requires_action` is local** until the gateway can be told; a customer who
  still approves is a late success that is refused and recorded.
- **The expiry sweep only expires `created` payments.** A payment with a provider operation
  is ended by the gateway's event or the chase job, never by `expires_at` (spec 17.5).

**Ledger**

- A success posts spec 5.5's collection entry in the same transaction, with `sourceId =
{paymentRef}:{eventKey}` (spec says the event id; the payment ref keeps two payments from
  colliding on one key). Fees are zero until the fee engine exists; `feeMinor` and
  `providerFeeMinor` on the signal already produce the fee lines.
- `PaymentsModule` imports `LedgerModule`, so the api process now loads it.

**Idempotency** (departures from spec 8.2)

- Postgres decides; Redis is an early check and may be absent. `environment` is part of the
  key. The row is inserted and completed in one transaction with the work, so `in_flight` and
  `failed` are never stored (the CHECK keeps them allowed). The "in progress" answer comes
  from a 2 s `lock_timeout` on the claim, not from a stored state.
- After 24 hours the record is recycled, but `payments` keeps `(merchant, environment, key)`
  unique for ever, so an old key cannot make a second payment: it answers `409
IDEMPOTENCY_KEY_REUSED`.
- A checkout session's client secret is returned once; a replay of its creation returns
  `clientSecret: null`.
- Replays and repeated cancels write no audit row (`markAuditNotApplicable`).

**Data**

- **New tables not in the spec:** `transaction_keys` (registry; partitioned tables cannot hold
  a unique `ref`) and `transaction_events` (the timeline and the record of refused events;
  the spec assembles the timeline from `gateway_events` and `merchant_events`, which do not
  exist yet). `checkout_sessions` gained amount, currency, description, success URL and
  metadata, because the spec table cannot create a payment lazily without them.
  `customer_id` and `parent_transaction_id` are left to the phases that need them.
- **Pagination key is `(created_at, ref)`**, not `(created_at, id)` (spec 6.5), so no internal
  id appears in a cursor; the indexes follow. `created_at` is set by the application clock at
  millisecond precision so cursors compare exactly.
- `payment_links.used_count` counts attempts started, and is not given back when a payment
  fails. A link's first use takes the use in the same transaction as the payment.
- **Phone numbers** must be in international form (`+` or `00`); national format is a 400
  because no country is trusted. Mobile money requires a number.
- **Amount limit:** at most 11 digits of major units, the gateway's `decimal(15,4)`.
- **Audit:** gateway-driven transitions are in `transaction_events`, not the audit chain.
- **New permissions** `payments:read` and `transactions:read` for every merchant role
  (migration 0003). Three older tests that listed all routes, amount columns or the viewer
  role's permissions were updated for the new entries.

## Phase 2 decisions to confirm

Choices made where the spec is silent, ambiguous or conflicts with the request. Each is
easy to change.

**Scope against the build order**

- **Built:** currencies, chart of accounts and seeds, merchant, provider, clearing,
  suspense and bank accounts, `account_balances`, `postEntry`, `reverseEntry`, all
  database invariants, integrity validation, trial balance, and the ledger-backed
  merchant close check (replacing `NoLedgerYetBalanceCheck`).
- **Not built, still Phase 2 in spec 14:** holds (place, capture, release, expiry job),
  available balance (`posted - held - reserved`), and the admin routes for accounts,
  journal entries, statements, trial balance and integrity. The request did not list them;
  holds are payout machinery and the request excluded payouts.
- **Not built, later phases:** the scheduled integrity run and the sev1 incident on
  failure (Phases 6 and 8), adjustments and reversals through the approvals workflow
  (Phase 4), ledger metrics (`core_ledger_*`).
- `LedgerModule` is not imported by any process yet, because nothing posts until the
  gateway consumer (Phase 3) and money movement (Phase 4). Tests import it.

**Departures from the spec text**

- **Environment.** Spec section 5 says test data never touches live ledger accounts, but
  `accounts`, `journal_entries` and `postEntry` have no environment. All three carry one;
  `accounts.code` is unique per environment.
- **Merchant account codes use the merchant ref** (`2000:merchant_payable:mch_...`), not
  the internal UUID the spec's `{merchantId}` suggests: codes appear in admin APIs and
  internal ids are never exposed.
- **`journal_entry_keys`** is not in the spec. Partitioned tables cannot hold a unique
  index without the partition key, so global uniqueness of the idempotency key, the ref
  and the reversed entry lives in this registry.
- **Balances are applied by a trigger** on `journal_lines`, not by service code as spec 6.6
  describes, so no code path can post a line without moving the balance. The service
  still locks the rows first, in ascending id order.
- **New columns:** `journal_entries.source_id` (the spec signature has `sourceId` but the
  table has no column for it) and `request_fingerprint`. `kind` defaults to the source.
  `created_by` is `{actorType}:{actorId}`. `posted_at` equals `created_at`; both are the
  database transaction time.
- **`reverseEntry` takes the transaction** and the entry by id or ref, so the approvals
  workflow can audit and reverse in one transaction.

**Behaviour**

- **Replay fingerprint** covers environment, currency, source, source id, kind,
  merchant, transaction, reversed entry and lines. Description and actor are excluded: a
  retry with another description replays rather than conflicts.
- **Negative merchant balances** are refused on the net change per account, and only when
  the posting lowers the balance. Paying back a negative balance is always allowed.
- **A reversal cannot be reversed**; re-post a new entry instead. Reversing an entry
  that touches an inactive account fails until the account is reactivated.
- **Merchant close counts live balances only**, read inside the close transaction.
  Test-mode balances are not money owed.
- **Error statuses:** posting errors are `422` (`LEDGER_POSTING_INVALID` with a `reason`,
  `LEDGER_ENTRY_UNBALANCED`, `LEDGER_ACCOUNT_NOT_FOUND`, `LEDGER_ACCOUNT_INACTIVE`);
  `LEDGER_IDEMPOTENCY_CONFLICT`, `LEDGER_ENTRY_NOT_REVERSIBLE` and `INSUFFICIENT_BALANCE`
  are `409`.
- **Property tests use a seeded PRNG** rather than adding `fast-check`. A failure prints
  the step; `LEDGER_PROPERTY_SEED` and `LEDGER_PROPERTY_OPS` reproduce it.
- **Line `metadata`** exists in the schema (spec 5.2) but `postEntry` does not accept it yet.

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

- **Close needs a zero balance.** Since Phase 2, `MERCHANT_BALANCE_CHECK` is the
  ledger-backed `LedgerMerchantBalanceCheck`. The write-off path needs the approvals
  workflow (Phase 4).
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
