# Architecture

Status: Phase 5 developer platform on top of Phases 0 to 2 and the payment and transaction
domain (without the Provider Gateway). This document grows with each phase. The specification is [CORE_API_BUILD_PROMPT.md](CORE_API_BUILD_PROMPT.md).
Authentication, authorization and key handling are detailed in [SECURITY.md](SECURITY.md).

## Processes

One codebase and one image; `APP_ROLE` picks the process (spec 4.1).

| Role       | Entry point            | Root module      | Does                                                                |
| ---------- | ---------------------- | ---------------- | ------------------------------------------------------------------- |
| `api`      | `src/main.api.ts`      | `AppModule`      | HTTP only. No workers, no pollers. Scales horizontally.             |
| `worker`   | `src/main.worker.ts`   | `WorkerModule`   | BullMQ workers and schedules for processors in `src/jobs`. No HTTP. |
| `consumer` | `src/main.consumer.ts` | `ConsumerModule` | Gateway event consumer and schedules (Phase 3). Singleton.          |

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

`src/common/queue/queue.definitions.ts` lists the queues and concurrencies from
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

## Holds and available balance

- `HoldsService.place` locks the merchant's payable `account_balances` row, then checks
  `available >= amount` and inserts the hold. The lock serialises placements per merchant and
  currency, so parallel payouts or refunds cannot reserve the same funds (spec 12).
- A hold ends once: `captured`, `released` or `expired`. Capture and release are idempotent on
  their own key; capturing a released hold is an error (spec 6.7). A key belongs to one hold.
- Capture does not post. The caller captures and posts the ledger entry in one transaction.
- `expires_at` is nullable. Payout and refund holds carry none: a hold must outlive an
  ambiguous gateway outcome (spec 6.3, 17.5). Only holds with an expiry are swept.
- `available` is computed from `account_balances` (payable), `holds` and, informationally,
  `transactions` in `processing`. `reserved` is 0 until Phase 6. The spec 5.5 settlement
  posting already moves the reserve out of the payable account, so subtracting reserves
  again would count them twice. **Open question for Phase 6.**
- Admin reads: `/admin/v1/{accounts, accounts/:code, accounts/:code/statement,
journal-entries, journal-entries/:ref, trial-balance, ledger/integrity, balances, holds}`
  with staff permissions `ledger:read`, `balances:read`, `holds:read` (migration 0004).
  The statement computes the running balance with a window function over the account's
  history up to the window end: exact, admin-only, not a hot path.

## Phase 2 decisions to confirm

Choices made where the spec is silent, ambiguous or conflicts with the request. Each is
easy to change.

**Scope against the build order**

- **Built:** currencies, chart of accounts and seeds, merchant, provider, clearing,
  suspense and bank accounts, `account_balances`, `postEntry`, `reverseEntry`, all
  database invariants, integrity validation, trial balance, and the ledger-backed
  merchant close check (replacing `NoLedgerYetBalanceCheck`).
- **Built after the first Phase 2 pass:** holds (place, capture, release, expiry sweep),
  available balance (`posted - held - reserved`) and the read-only admin routes for accounts,
  statements, journal entries, trial balance, integrity, balances and holds. See "Holds and
  available balance" below. Admin holds writes, adjustments and reversals wait for the
  approvals workflow (Phase 4).
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

## Developer platform (Phase 5)

Spec 6.11, 8.3, 8.5, 8.8 and 11, built on the Phase 1 key issuance. Guide for merchants:
[API_PUBLIC.md](API_PUBLIC.md). Security properties: [SECURITY.md](SECURITY.md). Runbooks:
[OPERATIONS.md](OPERATIONS.md).

**Request path for an API key request.** `AuthGuard`: failed-authentication limit (per client,
before the credential is read), then key lookup (Redis, then Postgres; constant-time hash compare;
environment, expiry, IP allowlist), then the per-key rate limits (one Lua script), then the CASL
scope check. After it, `RequestSignatureGuard` (headers, tolerance, HMAC, replay), the
idempotency interceptor and the handler. The `onResponse` hook buffers one request log row in
Redis.

**Outbox and events.** `MerchantEventsService.emit(tx, ...)` writes `merchant_events` and an
`outbox` row in the caller's transaction. Emitted today by the payment creator and lifecycle
(`payment.created`, `.requires_action`, `.succeeded`, `.failed`, `.expired`, `.cancelled`, and
`balance.updated` after a success), the holds service (`hold.created`, `hold.released`, also for
an expiry) and merchant suspend and activate (`merchant.suspended`, `merchant.activated`, live
environment). `webhook_endpoint.auto_disabled` is new in this phase. In the worker the
`OutboxDispatcher` claims rows with `FOR UPDATE SKIP LOCKED` (60 s claim, only for event types
it has a handler for), runs the handler in a transaction, publishes its queue jobs, then marks
the row published. Failures back off from 2 s to 5 min and stop after 10 attempts
(`core_outbox_exhausted_total`). Handlers are idempotent and their jobs carry deterministic ids,
so the at-least-once publish has an effect once.

| Outbox event type          | Handler                      | Does                                                       |
| -------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `merchant_event.created`   | `MerchantEventFanoutHandler` | one delivery per subscribed active endpoint, first attempt |
| `webhook.delivery_created` | `DeliveryCreatedHandler`     | first attempt of a replay                                  |
| `sandbox.payment_created`  | `SandboxPaymentHandler`      | first simulation step of a test payment                    |

**Jobs** (`src/jobs`, worker only). `outbox-dispatch` runs three ticks (job schedulers, so any
number of workers registers each once): `outbox.tick` every 1 s (dispatch, then re-queue webhook
attempts overdue by a minute), `request-logs.flush` every 2 s, `api-keys.flush-last-used` every
10 s. `webhook-delivery` runs one job per attempt. `gateway-chase` carries the sandbox steps; the
Phase 4 chase job will route by job name in the same processor.

**Webhook delivery** is detailed in [SECURITY.md](SECURITY.md). In short: a lease and a
conditional update make an attempt effect-once; the retry schedule (0 s, 30 s, 2 m, 10 m, 1 h,
6 h, 24 h, jittered by 20%) lives in the delivery service and Postgres; BullMQ's own 3 attempts
cover only infrastructure faults; and the 50th consecutive failure disables the endpoint in the
same transaction that announces it.

**Sandbox.** `PaymentCreator` enqueues `sandbox.payment_created` for a payment made in the test
environment. The worker resolves it by calling `PaymentLifecycleService.apply` (the same state
machine, ledger posting and events as live) with deterministic event keys, so test keys exercise
every path except the provider. See `modules/developer/sandbox`.

## Phase 5 decisions to confirm

**Scope against the build order**

- **Phases 3 and 4 are not complete.** Spec 14 and 17.2 build the gateway integration and money
  movement before this phase. Phase 3 is in the working tree, uncommitted
  (`src/integrations/gateway`), and was not touched; Phase 4 is partly done (payments, links,
  sessions, idempotency). This phase was built on request without them. Consequently these `/v1`
  groups of spec 7.1 are **not built**: `payment-methods` (needs routing), `refunds`, `payouts`,
  `payout-batches` (money movement, holds with approvals), `customers` (table, PII encryption and
  HMAC search), `settlements` (Phase 6) and `disputes` (Phase 7). Building them here would have
  meant building those phases' financial logic. Their scopes exist, and the signing, rate limit
  and payout-window rules are enforced by guards that read the route's scope; they are proven on
  a probe route (`test/support/developer.ts`). The sandbox therefore covers collections only.
- **The outbox** (a Phase 4 item) is built here in the form this phase needs: the write side,
  the dispatcher and three handlers. Notifications, reports and the other consumers of the
  outbox are not.
- **Events not yet emitted** because their modules do not exist: `refund.*`, `payout.*`,
  `settlement.*`, `dispute.*`, `kyc.*`. They can be subscribed to. `balance.updated` is emitted
  after a payment success only, not after hold changes or other postings.
- **Dashboard** routes added: `webhook-endpoints` (full CRUD), `webhook-deliveries` (list, get,
  retry, bulk replay) and `request-logs` (list, get). New merchant permissions `webhooks:read`,
  `webhooks:manage` and `request_logs:read` (migration 0005; table in SECURITY.md).

**Departures from the spec text and open choices**

- **Signing key and path** (see SECURITY.md): a separate encrypted signing secret per key, and
  the request target including the query string. The spec leaves both open.
- **Signing scope.** A live key holding `payouts:write` must sign every request, not only the
  payout routes.
- **Per-endpoint ordering (spec 8.9)** needs BullMQ Pro groups, which are not a dependency. Not
  built: deliveries may arrive out of order, which the guide tells merchants (events carry
  `createdAt`, and `/v1/events` is ordered). Revisit with the Phase 9 load tests.
- **Sandbox mapping.** The spec says "last two digits" without a table. Chosen: `01` fail, `02`
  timeout, `03` expire, `04` pending_then_succeed, otherwise succeed. `timeout` resolves to
  `expired` after `SANDBOX_TIMEOUT_RESOLVE_SECONDS` (120) and `pending_then_succeed` after
  `SANDBOX_PENDING_SECONDS` (5). An unknown `metadata.simulate` is a 422 in test mode.
- **Sandbox queue.** The simulation uses the `gateway-chase` queue, because spec 8.9 lists nine
  queues and none is for a simulator.
- **Endpoint verification** ("where specified"): the spec specifies none, so there is no
  challenge call at registration.
- **Auto-disable notification** is a merchant event plus an audit row. Email and in-app delivery
  arrive with Phase 8 notifications.
- **Rate limits.** `rate_limit_rpm` overrides the write limit, and the read limit never falls
  below the write limit. Refused requests are not counted; requests refused for a missing scope
  are. A client over `RATE_LIMIT_AUTH_FAILURE_PER_MIN` failed authentications gets 429 before its
  credential is examined (also for a valid key from that address). With Redis down, writes get 503.
- **Idempotency** is required where spec 7.1 requires it (payments, links and sessions already;
  refunds and payouts later). Webhook endpoint registration is not idempotent.
- **Replays** create a new delivery each time and are not deduplicated.
- **Out-of-band changes.** Editing `api_keys` or `merchants.status` directly in SQL is not
  evicted from the key cache: cached copies live up to 60 s (OPERATIONS.md). One test that
  suspended a merchant with SQL now evicts explicitly.
- **New configuration**: `RATE_LIMIT_BURST_CAPACITY`, `RATE_LIMIT_BURST_REFILL_PER_SECOND`,
  `RATE_LIMIT_AUTH_FAILURE_PER_MIN`, `WEBHOOK_ALLOW_PRIVATE_NETWORKS` (refused in production),
  `SANDBOX_PENDING_SECONDS`, `SANDBOX_TIMEOUT_RESOLVE_SECONDS` and `QUEUE_PREFIX`.
- **A new dev dependency**, `@apidevtools/swagger-parser`, validates the OpenAPI documents in the
  contract test.
- **Behaviour changes in shared code.** `WorkerHost.onApplicationBootstrap` now waits until its
  workers are ready (closing a worker before its connections are ready produced unhandled
  rejections). `OutboxRepository.claim` takes the event types a dispatcher can handle.
  `WorkerModule.forRoot` and `JobsModule.register` take `{ schedules }` so a test can boot a
  worker without repeating jobs. `ledger.merchantMovements` fingerprints a cursor by the filters
  asked, not the resolved window (a default window ends "now", which differs on every request;
  the admin statement still does the latter).
- **Existing tests changed**: the viewer permission list gained `webhooks:read`
  (`admin.int-spec`); the query budget test counts the read only, because the API key now comes
  from Redis (`transactions-queries.int-spec`); the public path list and a worker-boot test that
  now runs without schedules (`docs-and-processes.int-spec`); `queue.int-spec` awaits the new
  async bootstrap; one payment test evicts the key cache after a SQL suspension; and the test
  database allows 400 connections, because the suites run in parallel.

**Data**

- Tables `merchant_events`, `outbox`, `webhook_endpoints`, `webhook_deliveries` (partitioned) and
  `api_request_logs` (partitioned), and columns `api_keys.signing_secret_enc` and
  `signing_required` (migration 0005, [DATABASE.md](DATABASE.md)). Webhook endpoints are
  soft-deleted.
- `webhook_deliveries` and `api_request_logs` carry a `ref` whose ULID time equals `created_at`,
  so a lookup by ref reads one partition. A delivery created by fan-out takes its event's
  `created_at`, so a repeated fan-out produces the same `(dedupe_key, created_at)`.
- Query plans for the new hot queries are in [query-plans/phase5.txt](query-plans/phase5.txt).

## Phase 6 decisions to confirm

Choices made where the spec conflicts with itself, with the request, or is silent. Settlement and
reconciliation design is in [RECONCILIATION.md](RECONCILIATION.md). Decision IDs match
`phases_completion.md` (P6-D1 to P6-D13).

- **Settlement credits `1010:provider_float:{provider}`, not `1100:bank` (P6-D1). Open
  architectural conflict.** Spec 5.5 posts the confirmation as `DR 1200 / CR 1100:bank`. Spec 6.9
  routes the payout through the gateway, so the cash that leaves is the provider float, and the
  daily balance proof compares that account with the gateway balance. This is the one departure
  from the spec's own posting text. One line in `settlement/domain/settlement-posting.ts` reverts
  it. Not to be changed silently either way.
- **Reversals need approval, not only write-offs (P6-D2).** Spec 6.6 and 11 require approval for
  every manual reversal, so `corrected_with_reversal` goes through the same maker-checker.
- **Any ledger integrity finding opens a sev1, including a non-empty suspense account (P6-D3).**
  `SUSPENSE_ALERT_HOURS` (spec 6.14 and 10) is not used by this incident, so a suspense balance
  cleared within the hour still opens one. Phase 8's drift monitor defers to it. Decide which
  spec rule wins and whether a grace period applies.
- **`reserved` stays 0 in the merchant balance and `available` is unchanged (P6-D4, P4-D8).** The
  settlement entry already moves the reserve out of the payable account, so subtracting reserves
  as well would count them twice.
- **The settlement payout is a `transactions` row of type `settlement`**, with gateway key
  `po_{ULID}` (P6-D5), because the `payouts` table belongs to Phase 4.
- **Balance proof mapping (P6-D6).** Clearing is compared with the gateway `collection` balance and
  float with its `disbursement` balance. The gateway reports two accounts; the spec says "the sum".
- **Release is asynchronous (P6-D7).** The route answers with the batch `releasing`; a worker
  sends the payout after commit.
- **A completed settlement run is final for its period (P6-D8).** A batch cancelled afterwards is
  settled by the next period's run.
- **Merchant events (P6-D9).** `settlement.created` on submit for approval, `settlement.paid` on
  pay. `balance.updated` is not emitted for settlements.
- **New queue `reconciliation-run`, concurrency 2 (P6-D10).** Spec 8.9 lists nine queues and none
  for scheduled reconciliation. `settlement-run` retries payout submission 8 times.
- **New direct dependency `cron-parser` ^4.9.0 (P6-D11).** Already installed through BullMQ.
- **Permission names (P6-D12).** `settlement:{read,prepare,approve,release}`,
  `reconciliation:{read,work,approve}` and merchant `settlements:read`. `manage` is avoided because
  CASL treats it as every action. Only `super_admin` approves; `operations` prepares and releases;
  `auditor`, `compliance` and `support_agent` read (migration 0006).
- **Exceptions are addressed by `rce_` ref and staff by `usr_` ref (P6-D13).** The spec writes `:id`.

## Compliance (Phase 7)

KYC, AML and disputes (spec 6.13, 6.14). Three modules, none of which owns financial truth: a
rule, an alert or a case decides whether to look at money or to stop a payout. The only paths to
balances are `HoldsService` (holds) and `PostingService`/`ReversalService` (a lost dispute).

```
src/modules/kyc/        profiles, requirements as data, documents, submission, review, expiry
src/modules/aml/        screening, pre-check, monitoring, rules, alerts, cases, STR, blocklist, block
src/modules/disputes/   disputes and chargebacks
src/integrations/storage/    S3-compatible object storage behind `ObjectStorage`
src/integrations/sanctions/  sanctions and PEP screening behind `SanctionsScreening`
```

### KYC

- **Levels.** `merchants.kyc_level` is the level a merchant is approved at. `kyc_profiles.level`
  is the level being applied for. 0 is sign-up (test keys), 1 identity and contact, 2 business
  registration, TIN and bank account, 3 directors, UBOs and source of funds.
- **Requirements are rows of `kyc_requirements`.** A row applies when it is active, its level is at
  or below the target and its country and business type are `*` or equal the merchant's. Where
  several share a `requirement_code` the most specific wins, so a country or a business type adds
  a requirement or relaxes one (`mandatory = false`) without code (`domain/requirements.ts`).
  Each row says how it is evidenced: a `document` type, a `profile_field`, a `party` kind or a
  staff `verification` check. An upgrade does not ask again for what an earlier approval verified.
- **State machine** (`domain/kyc-state.ts`, mirrored by a trigger): `not_started -> pending ->
in_review -> approved | rejected`, `in_review -> pending` after a request for information,
  `approved -> expired | pending` (upgrade or renewal), `rejected | expired -> pending`.
- **Submission** needs every mandatory item the merchant can supply, moves `draft -> pending_kyc`
  through the merchant lifecycle's own rule, and queues screening through the outbox.
- **Approval** (`KycReviewService.approve`) is one transaction under the merchant and profile row
  locks: limits from `kyc_level_limits`, the merchant's level and status (`pending_kyc -> active`),
  the profile, the review log, the merchant events and, last, the audit row. It needs every
  mandatory requirement verified, a clear screening for the merchant and every active director and
  UBO of the submission, and an approver who did not verify any document or check in this round
  (maker-checker, spec 11). Tests fail the audit write and the event write and assert that the
  profile, merchant, limits and events are all unchanged.
- **Documents** go straight to object storage. `presign` signs the content type, the exact length,
  the SHA-256 and the server-side-encryption header into a PUT URL; `confirm` checks the object
  (size, the checksum the store verified, and the first 16 bytes against the PDF, JPEG or PNG
  signature) and only then writes the row. A file that fails is deleted. Core never reads the
  whole file. Staff open a file through a presigned GET of at most five minutes, issued only after
  its audit row is committed.
- **Re-verification.** Approval sets `expires_at` (`KYC_VALIDITY_DAYS`) and `next_review_at`
  (`KYC_REVERIFY_NOTICE_DAYS` earlier). An hourly sweep emits `kyc.reverification_due` once, and
  moves an unrenewed profile to `expired` after `expires_at`. A renewal asks for fresh checks.
  Staleness is counted in submissions, not timestamps (`kyc_reviews.submission_no`), so two events
  in one millisecond cannot be ordered wrongly.

### AML

- **Screening** (`aml-screen` queue): the merchant, each director and each UBO, one job per subject
  keyed by (profile, submission, subject). The provider is called outside any transaction. A
  result at or above `AML_SCREENING_REVIEW_SCORE` is a potential match, at or above
  `AML_SCREENING_CONFIRM_SCORE` a confirmed match. Both stop activation. A confirmed match opens
  an AML case and writes an audit row in the same transaction; an analyst decides a potential
  match once. A provider that does not answer records nothing and the approval stays refused.
- **Pre-transaction check** (`AmlPrecheckService`, called by `PaymentCreator` for live payments
  before anything is written): merchant status from the scope, the blocklist in one Redis
  pipeline, the per-transaction limit from cached limits, and daily and monthly volume in one Lua
  script that checks and increments atomically. No SQL on the hot path unless a counter has to be
  rebuilt. If Redis cannot answer the payment is declined with 503.
- **Post-transaction monitoring.** `PaymentLifecycleService` enqueues an outbox row in the same
  transaction as any live payment's move to a terminal status; the dispatcher turns it into one
  `aml.monitor-transaction` job. The job takes a per-merchant advisory lock, writes the
  transaction's fact row (its idempotency marker) and evaluates every enabled rule that was in
  force when the payment completed. Rule types: `velocity` (count or value), `amount_threshold`,
  `structuring`, `geography`, `new_account`, `round_amount`, `counterparty_reuse`. Parameters are
  validated per type (`domain/rule-params.ts`); money is a string of minor units.
- **Alerts** carry the rule version, severity, score, a `due_at` from `AML_ALERT_SLA_HOURS_*`, an
  assignee, the transaction and the merchant. A minute sweep escalates alerts past `due_at`.
- **Actions.** `flag` raises the alert. `hold` also holds the payment amount (or what is available
  of it). `block` also blocks the merchant.
- **Block** (`AmlBlockService`): holds the whole available balance per currency (`aml:block:{ref}`,
  counted as an AML hold by settlement) and suspends payouts. `PayoutControlService` answers from
  PostgreSQL; the settlement release and its payout submission ask it. A block never touches a
  transaction or a ledger entry, and the merchant is not told.
- **Cases and STR.** A case gathers alerts through `aml_alerts.case_id`, carries append-only
  notes and an outcome, and exports an STR package: one JSON document in the reports bucket, its
  SHA-256 recorded, a presigned download.

### Disputes

Opening a dispute holds the disputed amount (`dispute:{ref}`) under the balance lock. A lost
dispute captures the hold and posts: a reversal of the payment's collection entry when the whole
payment is disputed, a compensating entry (merchant payable to provider clearing) for a part. A
won or withdrawn dispute releases the hold and posts nothing.

### Processes and queues

All compliance work runs in the `worker` process on the `aml-screen` queue (8 attempts, backoff
from 10 s, so about 21 minutes of provider outage): `kyc.screen-subject`,
`aml.monitor-transaction`, `aml.tick` (every minute), `aml.blocklist-rebuild` (every 5 minutes) and
`kyc.lifecycle-sweep` (hourly). Every job is idempotent; `test/integration/compliance-jobs.int-spec.ts`
runs each twice.

## Phase 7 decisions to confirm

Choices made where the spec is silent, ambiguous or differs from the request.
**Differences from the request or the spec text**

- **Document statuses.** The request names `pending`, `approved`, `rejected`; spec 5.2 names
  `uploaded`, `verified`, `rejected`. The spec is the master, so the database uses its names:
  `uploaded` is the request's pending, `verified` its approved.
- **`aml_screenings.subject_type`** also allows `ubo` (spec 6.13 screens UBOs; 5.2 lists no such
  type). **`kyc_verifications.check_type`** also allows `contact` (level 1 asks for contact
  verification). Both are additive check-constraint values.
- **Directors and UBOs live in `kyc_parties`**, with encrypted name, date of birth and ID number,
  not in `merchant_profiles.directors jsonb` (5.2): screening needs a row per person to point at.
- **A case holds its alerts through `aml_alerts.case_id`**, not an `alert_ids uuid[]` column
  (5.2), so a foreign key keeps an alert in at most one case.
- **Rule parameters carry the currency and the window.** `aml_rules` also has effective dates and
  an append-only `aml_rule_versions` history, for the request's "effective dates" and "audit trail".
- **Added routes** (spec 7 lists none): `PUT /dashboard/v1/kyc/profile`, `.../kyc/parties` (GET,
  POST, DELETE), `POST /admin/v1/kyc/:merchantRef/checks`, `POST /admin/v1/kyc/requirements` and
  `PATCH`/`DELETE .../requirements/:id`, `POST /admin/v1/aml/rules`, `POST
/admin/v1/aml/screenings/:ref/decide`, `GET`/`POST /admin/v1/aml/blocks` and `POST
.../blocks/:ref/lift`, `POST /admin/v1/disputes`. The blocklist delete is addressed by ref.
- **Public `/v1/disputes`** (spec 7.1) is not built: the dashboard and admin routes are. The
  request lists dispute handling, not the merchant API surface for it.
- **New permissions** (migration 0007): staff `kyc:read|review|approve|view_documents|requirements`,
  `aml:read|work|rules|blocklist|block|str`, `chargebacks:read|work|resolve`; merchant `kyc:view`,
  `kyc:submit`, `disputes:read`, `disputes:write`. A key cannot be both a staff and a merchant
  permission, hence `kyc:view` for merchants and `kyc:read` for staff.
  **Policy values that need a decision**
- **Limits per level** (`kyc_level_limits`) are placeholders: USD 300 / 1,000 / 5,000
  (per transaction, a day, a month) at level 1, 3,000 / 20,000 / 200,000 at level 2 and 30,000 /
  200,000 / 2,000,000 at level 3, converted at rounded rates into each currency. Payout limits
  equal collection limits and are stored but not enforced yet (no payouts module). Compliance must
  set the real numbers.
- **The monitoring rules are seeded disabled**, one per type, in UGX. Until someone reviews the
  thresholds and enables them (per currency) nothing is monitored. See OPERATIONS.md.
- **KYC validity** is 365 days and the notice 30 days (`KYC_VALIDITY_DAYS`,
  `KYC_REVERIFY_NOTICE_DAYS`). The spec fixes only the 30 days.
- **Limit consequences of expiry** are not defined by the spec, so none is applied. The mechanism
  exists as data: a `kyc_level_limits` row with `applies_when = 'expired'` is applied on expiry
  and the renewal restores the `approved` limits. An expired merchant keeps its status and level.
- **Screening thresholds** (0.7 review, 0.9 confirm) and **alert SLAs** (low 72 h, medium 24 h,
  high 8 h, critical 4 h) are defaults.
- **A confirmed PEP match blocks activation**, as the request says. Many regimes treat a PEP as
  enhanced due diligence rather than a bar; this needs a compliance decision.
- **`complyadvantage`** is accepted by the config schema but has no adapter: the system fails
  closed (screenings fail, approval is refused). Only OpenSanctions is implemented.
  **Behaviour choices**
- **A merchant without limits is declined**, not let through: a live merchant with neither its own
  row nor limits for its level and currency gets `TRANSACTION_DECLINED`.
- **The pre-check fails closed**: a Redis failure declines the payment (503). Counters are exact
  below 2^53 minor units; larger amounts are declined. A payment that is declined later in the
  same transaction leaves its volume counted until the counter is rebuilt.
- **Volume counters use UTC days and months** and are rebuilt from the database on a miss. The
  spec's rebuild source (`daily_merchant_rollups`) is a Phase 8 table.
- **A dispute is never refused for lack of funds.** If the balance cannot cover it, what is
  available is held and the rest recorded as `shortfall_minor`. A lost dispute that would take the
  balance below zero is refused (409) unless staff pass `acceptDeficit`, which is audited and
  shows up in the ledger integrity run as a negative merchant payable (spec 5.3 rule 7).
- **A lost whole-payment dispute reverses the collection entry**, which also reverses its fee
  lines; fees are zero until the fee engine exists. A part is a compensating entry. Spec 6.14
  says only "a reversing entry".
- **A block does not hold money that arrives after it.** It holds the balance at that moment and
  suspends payouts. Merchants can see a hold exist (`hold.created`, the holds list) but never its
  reason; no merchant event says "blocked". Tipping-off rules differ by jurisdiction.
- **Closing an AML case and resolving an alert are audited**; resolving an alert and generating an
  STR need step-up. Closing a case does not, because a route cannot conditionally require it.
- **STR packages include directors' and UBOs' names**, decrypted for the export, and ID numbers and
  the TIN as their last four characters. The file is encrypted at rest by the bucket.
- **The KYC review queue is newest first**, because the pagination helper (spec 8.6) is
  descending-only.

## Support and operations (Phase 8)

Built on the Phase 5 outbox and the Phase 6 and 7 services; no Phase 3 or 4 code is needed. Migration
`0008_support_operations.sql`.

### Complaints

Merchants and staff file complaints (`/dashboard/v1/complaints`, `/admin/v1/complaints`); customers'
complaints arrive only through staff. A category carries the hours it is answered within
(`complaint_categories.sla_hours`); the deadline `sla_due_at` is fixed at filing and never changes (database
guard). The minute sweep (`support-ops`, `ComplaintsService.sweepSla`) records a breach once, at the deadline, and
tells staff through a mandatory notification. A breached complaint stays in the queue
(`GET /admin/v1/complaints/sla-breaches`) until it is resolved. Customer-sourced complaints are hidden from
merchants; the customer's contact is encrypted and read only through an audited route.

### Disputes (operations)

Phase 7 opened, held and resolved disputes. Phase 8 adds an assigned investigator, append-only notes, an evidence
deadline with a warning (`DISPUTE_DEADLINE_WARNING_HOURS`) and the deadline sweep. Resolution still goes through
the Phase 7 financial service; nothing here posts to the ledger.

### Incidents and the public status feed

Incidents have a status (`investigating`, `identified`, `monitoring`, `resolved`), a timeline, a postmortem and a
`dedupe_key`. `IncidentsService.openAutomatic` is the one way a machine opens an incident: one open incident per key,
with a detection counter and a severity that can only rise. A machine moves a cleared incident to `monitoring`; only a
person resolves one. `GET /v1/status` (no authentication, cached 30 s, also `GET /dashboard/v1/status`) exposes the
public headline, a coarse impact, a whitelist of component names (`PUBLIC_COMPONENTS`) and updates marked public.
Resolved public incidents stay 14 days. Internal updates, the postmortem, the cause and the commander are never public.

### Automatic incidents

`OpsMonitorService.evaluate` runs every `OPS_MONITOR_INTERVAL_SECONDS` on `support-ops`. Signal state is in
`ops_signals` (`active_since`), so the duration of a condition survives restarts.

| Signal                                                                          | Opens                              | Severity                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| Ledger integrity                                                                | the Phase 6 hourly run (unchanged) | sev1                                                                                                |
| Suspense non-zero                                                               | after `SUSPENSE_ALERT_HOURS`       | sev2, sev1 after `OPS_SUSPENSE_SEV1_HOURS`; not while a `ledger_integrity:{env}:*` incident is open |
| Processing transactions older than `OPS_STUCK_TXN_MINUTES`                      | at once                            | sev3, sev2 from `OPS_STUCK_TXN_SEV2_MINUTES`                                                        |
| A queue above `OPS_QUEUE_DEPTH_THRESHOLD` for `OPS_QUEUE_DEPTH_SUSTAIN_SECONDS` | after the sustain time             | sev3, sev2 at five times the threshold                                                              |

### Notifications

`NotificationsService.notify` writes one `notifications` row per recipient user (merchant and staff audiences are
expanded first), keyed by recipient, template and resource, and suppresses a duplicate inside 5 minutes. Templates are
unique on (code, channel, locale). Preferences apply except for mandatory templates (security, disputes, SLA breach,
incidents). The in-app channel is the row itself (unread count, list, mark read, bulk read). Email, SMS and push are
`notification_deliveries` rows (monthly partitions) sent by the `notification-send` queue through ports in
`src/integrations/messaging`: Resend and Postmark, Africa's Talking, and FCM HTTP v1. A delivery retries with
exponential backoff up to `NOTIFICATION_MAX_ATTEMPTS`, then is `failed` with a short error code; a refusal retrying
cannot change fails at once. SES and Twilio fail closed (`channel_not_configured`). Events that merchants are told
about reach the service through a second outbox row, `notification.merchant_event`.

### Reports

`POST .../reports` answers `202` with a reference. The outbox row `report.requested` queues `report-generate`. The worker
claims the report under a lease, reads the data through a server-side cursor (`DECLARE ... CURSOR` in a `REPEATABLE READ
READ ONLY` transaction on the replica pool, `REPORT_CURSOR_BATCH_SIZE` rows at a time), writes CSV or JSON and uploads it
as an S3 multipart upload (`ObjectStorage.putStream`, parts of `REPORT_MULTIPART_PART_BYTES`), so the file is never held
in memory. A download is a presigned link valid 15 minutes (audited); the file is deleted after 7 days. Thirteen types,
each with a default window and a bound on every partitioned table. Schedules (`report_schedules`) create one report per
due time, idempotently, and turn themselves off after `REPORT_SCHEDULE_MAX_FAILURES` consecutive failures.

### Rollups and analytics

`daily_merchant_rollups` is recomputed per UTC day: today every 15 minutes (and yesterday in the first hour of a day), and
the previous days each night at 01:30 UTC. A recompute is a whole-day replace, so it is idempotent and a late run corrects
itself. Dashboard analytics and the operations overview read only the rollups.

### Operations surface

`/admin/v1/ops/*`: overview, queues (depth, pause, resume, retry failed), the consumer cursor and its lag, stuck
transactions, suspense, feature flags, maintenance mode, the approvals inbox; `/admin/v1/providers` and
`/admin/v1/routing-rules`. Every write is audited and counted in `core_ops_actions_total`.

**Approvals.** `core.approvals` plus an executor registry. Four kinds: `consumer_cursor.rewind`, `feature_flag.change`,
`provider.disable`, `routing_rule.remove`. A request answers `202`; a different staff member with `ops:approve` and a recent
step-up approves, and the change is applied in the same transaction as the decision. The requester cannot approve (service
and database check). A pending request expires after `APPROVAL_TTL_HOURS`. `OpsChangeApplier` is the one place a change is
applied, for the direct and the approved path alike.

**Providers and routing.** Disabling a provider, or setting its health to `down`, applies at once only if every currency
routed to it has another enabled provider with an enabled rule. Otherwise it needs a reason and an approval. Deleting a
routing rule, and disabling the last enabled rule of a currency, always need an approval.

**Maintenance mode.** `MaintenanceGuard` is a global guard ahead of authentication. While on, every write on every surface
answers `503 MAINTENANCE_MODE` with `Retry-After`; reads, the switch itself and sign-in, refresh, MFA and step-up stay open.
State is one row in Postgres, cached in process for 2 seconds. If the row cannot be read the guard lets the request through
and logs it (the database being down already fails the write).

**Feature flags.** `OPS_FLAG_CHANGE_APPROVAL` (`production`, `always`, `never`) decides when a flag change needs approval;
`never` is refused in production.

### Processes and queues

`support-ops` (concurrency 1, one attempt, every tick is idempotent and runs again a minute later): complaint SLA sweep,
dispute deadlines, approval expiry, the incident monitors. `notification-send` has 6 attempts with a 30 s exponential
backoff, `report-generate` 3 attempts with a 30 s backoff, `rollup-aggregate` runs the two rollup jobs.

### Runbooks and load

`docs/OPERATIONS.md` is executable: `test/integration/runbooks.int-spec.ts` runs its tagged SQL and HTTP blocks against
scenarios. `npm run test:load` measures the spec 9.1 targets (`docs/LOAD_RESULTS.md`).

## Phase 8 decisions to confirm

**Differences from the spec text**

- **Notification templates are unique on (code, channel, locale)**, not on `code` (spec 5.2): one code has one template
  per channel and language.
- **`daily_merchant_rollups` has `environment` in its primary key.** Test and live volume must not mix.
- **Notification rows are always per user** (`recipient_type = 'user'`). A merchant or staff-group audience is expanded
  to its members before insert.
- **`notification_deliveries` is partitioned monthly; `notifications` is not.** Deliveries are the high-volume,
  short-lived table.
- **`consumer_cursors` is created in migration 0008**, because the consumer (Phase 3) is not built. The gateway lag is read
  with the read-only pool from `public.operation_events`. When Phase 3 lands it adopts this table.
- **An extra queue, `support-ops`**, beyond the nine of spec 8.9, for the minute sweeps.
- **Reports are CSV and JSON.** `xlsx` and `pdf` answer `REPORT_INVALID` (`format_not_supported`). The payouts and refunds
  reports read `transactions` filtered by type, because there are no payout or refund tables yet.
- **Staff can file a complaint on behalf of a customer or merchant**, and customer contact reveal is its own audited
  route. The spec lists neither.
- **Added routes:** notification destinations (`PUT`/`DELETE /dashboard/v1/notification-destinations` and the admin
  equivalent) so SMS and push have an address; `GET /v1/status`.

**Policy values that need a decision**

- Complaint category SLA hours (`complaint_categories.sla_hours`; for example 96 hours for `other`), and that the SLA is calendar
  time, not business hours.
- The incident monitor thresholds and severities (table above), and that a cleared signal only moves an incident to
  `monitoring`.
- `OPS_FLAG_CHANGE_APPROVAL` (default `production`), `APPROVAL_TTL_HOURS` (24), the 1,000-recipient broadcast cap.
- Public status: the component whitelist, the 14-day window for resolved incidents, the 30-second cache.
- Report limits: `REPORT_MAX_ROWS`, `REPORT_MAX_ACTIVE_PER_MERCHANT`, the 15-minute link and the 7-day file life (constants,
  not configuration), and that a scheduled report may go only to members of the merchant (or staff), never to an arbitrary
  address.
- Which notification templates are mandatory (they ignore preferences): security, disputes, SLA breach, incidents.
- The rollup lookback of the recompute jobs.

**Behaviour choices**

- **Suspense is reported twice.** The Phase 6 hourly integrity run (spec 6.8 lists a non-zero suspense) opens a sev1
  incident immediately; the Phase 8 drift monitor (spec 6.14: after an hour) opens sev2 and sev1 later. The drift monitor
  stays quiet while a `ledger_integrity` incident is open, so there is one incident, not two. Phase 6 was not changed.
- **A machine never resolves an incident.** A person does, with the cause in the final update.
- **Maintenance mode fails open** when its row cannot be read, and the request would fail anyway if the database is down.
- **Provider disable is conditional.** It applies at once only when another enabled provider covers every currency routed
  to it (otherwise an approval), so one person cannot stop payments in a currency.
- **A notification can be sent twice, never zero times**: a worker that dies after the vendor accepted a message and before
  the row is marked sent leaves it pending, and the sweep sends it again. The delivery reference is sent as the vendor's
  idempotency key for email.
- **Report generation is not resumable.** A failed attempt starts the report again; a failed upload is aborted, so no partial object is left.
- **Skipped (not built, see the report to the requester):** `GET /admin/v1/ops/gateway-health`, `POST /admin/v1/ops/gateway/replay-events`
  (they need the Provider Gateway client), report schedules for staff, Redis pub/sub invalidation of the flag cache across
  processes (the 2-second in-process cache is the bound today), per-endpoint webhook ordering.
- **Load targets.** `docs/LOAD_RESULTS.md` records what was measured and on what. The event consumer target (500 events/s)
  is not measured, because the consumer is not built. The soak test belongs to Phase 9.

## Production hardening (Phase 9)

What Phase 9 did and did not do, and the decisions it leaves open. The readiness verdict is in
`PRODUCTION_READINESS.md`.

**Added**: partition automation and retention (`src/modules/lifecycle`, migrations 0009 and 0010, the
`data-lifecycle` queue); three connection-handling fixes found by the chaos suite: a connection that dies in use no longer crashes the process (DB-2), a silent connection is bounded by a client-side timeout (DB-3), and a connection failing at `BEGIN` is no longer leaked (DB-4) (`src/common/db/pools.ts`, `src/common/db/unit-of-work.ts`); a migration job that needs only the database URL (`src/db/migrate-config.ts`); the
`core_ledger_posting_duration_seconds` metric and the partition gauges; a chaos and recovery suite
(`npm run test:chaos`), a soak harness (`npm run test:soak`), a database-security suite and an independent
financial-invariant checker.

**Not added, because it would be new business functionality or an architecture change**: the gateway event
consumer, merchant payouts, refunds and gateway collections (Phases 3 and 4); load shedding; a KMS-backed
encryption key; separation of the database owner role from the application role; a sharded audit chain.

### Decisions to confirm (Phase 9)

| #   | Decision                                                                                                                                                                                                         | Where                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | Separate the owner and migrator database role from `mulapay_core_rw` (spec D2 says rw has full rights on `core`). Needed to make the append-only controls hold against stolen credentials (DB-1).                | `SECURITY.md`           |
| 2   | KMS-wrapped data keys, a keyring that decrypts with previous keys, and a re-encryption job (ENC-1). Today a key change makes every encrypted column unreadable.                                                  | `SECURITY.md`           |
| 3   | The audit hash chain serialises every audited write platform-wide (PERF-2). Options: one chain per merchant or per shard, or a sequencer that hashes after commit. Each changes what `audit-logs/verify` proves. | `LOAD_RESULTS.md`       |
| 4   | Whether an exhausted pool should answer `503` with `Retry-After` (PERF-3), and whether to build load shedding (PERF-1).                                                                                          | `SECURITY.md`           |
| 5   | Retention periods for `idempotency_keys` rows (7 days after expiry) and published `outbox` rows (14 days) are not in the spec; chosen to be longer than the 24-hour replay window and any retry.                 | `DATABASE.md`           |
| 6   | The transaction index `transactions_final_day_idx` was measured and not added; add it when a day's rollup window passes about five million rows.                                                                 | `query-plans/README.md` |

### Process lifecycle, verified against the built artefact

`test/chaos/shutdown.chaos-spec.ts`: the API keeps running after `SIGTERM` until the request it had accepted is
answered, then exits cleanly; idle it exits in about a second; the worker exits cleanly. The runtime image was run with a
read-only root filesystem: it boots, answers liveness and readiness, refuses unsafe production configuration by
naming the variables, and stops in about a second with status 0.
