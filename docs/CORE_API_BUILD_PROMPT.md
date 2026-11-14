# MulaPay Core API — Build Specification

This document is the complete brief for building **MulaPay Core API**, the service that
owns money, merchants and compliance for the MulaPay platform. It is written to be handed
to an engineer or a coding agent and worked through end to end.

Repository root: `/Users/caleb/Dev/Praise IT/MulaPay/core_api` (its own git repository).
Sibling service: `/Users/caleb/Dev/Praise IT/MulaPay/provider_gateway` (already built).

Read sections 1 to 4 before writing any code. Section 14 defines the build order.

---

## 1. Scope and boundaries

### What the gateway owns (do not rebuild it)

The provider gateway owns the conversation with MTN Mobile Money, Airtel Money and
Flutterwave. It owns provider credentials, provider error mapping, provider timeouts,
retry policy, callback verification, and the authoritative status of every provider
operation. It is the **only writer** of `provider_operations` and `operation_events`.

### What Core API owns

| Domain | Responsibility |
| --- | --- |
| Payments | Merchant-facing charge object and its lifecycle, payment links, checkout sessions |
| Collections | Inbound money orchestration under payments: provider routing, initiation, status chase |
| Disbursements | Payouts to customers and merchants, single and batch, approval workflow |
| Refunds | Full and partial refunds against a payment, approval workflow |
| Transactions | The unified money-movement record every surface reads from |
| Double-entry ledger | Append-only journal, chart of accounts, trial balance, integrity proofs |
| Accounts | Chart of accounts, merchant accounts, provider float and clearing accounts |
| Balances | Posted, available, pending and reserved balance per merchant per currency |
| Holds | Reservations against available balance, with capture, release and expiry |
| Reconciliation | Gateway-to-core gap detection, ledger integrity, provider statement matching, exception queue |
| Settlement | Payable calculation, settlement cycles, rolling reserve, batch release, settlement reports |
| Merchant management | Merchant onboarding, profiles, team, fee plans, limits, lifecycle states |
| Developer API | Public merchant API, sandbox, OpenAPI reference, request logs |
| API keys | Issue, scope, rotate, revoke, IP allowlist, per-key rate limits |
| Merchant webhooks | Endpoint registration, HMAC-signed delivery, retries, delivery log, replay |
| Reports | On-demand and scheduled reports, async generation, signed download links |
| Notifications | Email, SMS, push and in-app, templates, preferences, delivery log |
| KYC | Tiered verification, document capture, business and director verification, re-verification |
| AML | Sanctions and PEP screening, transaction monitoring rules, alerts, cases, STR export |
| Complaints | Customer and merchant complaints, SLA tracking, disputes and chargebacks |
| Incidents | Internal incident lifecycle, severity, timeline, postmortem, status page feed |
| Audit | Hash-chained append-only log of every state-changing action |
| Operations | Back-office tooling: queues, cursors, stuck transactions, feature flags, approvals |

### Consumers of Core API

1. **Merchant servers** via the public API (`/v1`, API key auth).
2. **Merchant dashboard** web app, to be built later (`/dashboard/v1`, JWT auth).
3. **Admin console** web app, to be built later (`/admin/v1`, JWT auth plus MFA).

Both web apps are out of scope here. Core API must expose everything they need and
nothing more.

### Explicit non-goals

- No direct provider HTTP calls. Every provider interaction goes through the gateway.
- No writes to gateway-owned tables, ever.
- No reimplementation of provider reconciliation. Core reconciles its own records
  against gateway events and against provider statements, which is a different job.
- No front-end code.

---

## 2. Technology decisions (already made)

Each row is a decision, not a suggestion. If you believe one is wrong, raise it before
building rather than quietly substituting something else.

| Concern | Decision |
| --- | --- |
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess: true` |
| Framework | NestJS 11 on the Fastify adapter (`@nestjs/platform-fastify`). Express is not permitted |
| Database | PostgreSQL 16+, shared instance with the gateway, **separate `core` schema** |
| DB access | Drizzle ORM with `node-postgres` |
| Migrations | `drizzle-kit`, restricted to the `core` schema |
| Validation | Zod via `nestjs-zod`. Global `ZodValidationPipe`. `class-validator` is not permitted |
| Serialization | Fastify response schemas (`fast-json-stringify`) generated from the Zod schemas |
| Cache, locks, limits | Redis 7 via `ioredis` |
| Queues | BullMQ, workers in a **separate process** from the API |
| Money in the ledger | `bigint` minor units. Decimal strings only at the API edge |
| Decimal math | `decimal.js` at conversion boundaries only. Never `number` for money |
| Merchant auth | API key: `mp_{live\|test}_{keyId}_{secret}`, SHA-256 of the secret stored |
| Dashboard auth | Own JWT: Ed25519 access token (10 min) plus rotating refresh cookie |
| Password hashing | `argon2id` (`argon2` package) |
| MFA | TOTP (`otplib`), mandatory for all admin staff and for payout approval |
| Authorization | CASL (`@casl/ability`), one ability factory per actor type |
| IDs | UUID v7 for internal primary keys, prefixed ULID-style for public IDs (`pay_`, `po_`, `rf_`, `txn_`, `mch_`) |
| Logging | Pino, structured JSON, redaction list, `requestId` and `trace_id` on every line |
| Tracing | OpenTelemetry over OTLP/HTTP, same collector as the gateway |
| Metrics | `prom-client` at `GET /metrics`, bearer-token protected, `core_` prefix |
| API docs | `@nestjs/swagger` fed from Zod schemas, rendered with Scalar |
| Testing | Vitest plus Testcontainers (Postgres and Redis). Jest is not permitted |
| HTTP client | `undici` (matches the gateway) |
| Object storage | S3-compatible, presigned PUT for uploads, presigned GET for downloads |
| Container | Multi-stage Dockerfile, non-root user, read-only root filesystem |
| Edge | Nginx or Cloudflare terminates TLS, caps body size and applies a coarse L7 rate limit |
| Pooling | PgBouncer in transaction mode in front of Postgres |

### The seven architecture decisions and why

**D1. Core lives in its own `core` Postgres schema.**
The gateway's Knex migrations own `public`. Core's `drizzle-kit` migrations own `core`.
Neither tool ever sees the other's objects, so migrations cannot collide and nothing in
core can accidentally alter a gateway table.

**D2. Core gets two database roles.**
`mulapay_core_rw` has full rights on `core` and **no rights at all** on gateway tables.
`mulapay_core_ro` has `SELECT` only on `public.operation_events` and
`public.provider_operations`. The gateway doc states it must remain the sole writer of
payment state; enforcing that with a role means it holds even if someone writes careless
code. Core opens separate connection pools per role.

**D3. Outcomes are consumed by reading `public.operation_events` directly.**
Same database, so this avoids an HTTP hop and a failure mode, and the gateway's
integration doc explicitly sanctions it. The read goes through an interface
(`GatewayEventSource`) with a second implementation that polls
`GET /api/v1/events`, so switching later is a one-file change.

**D4. Core is a single gateway tenant.**
Core authenticates to the gateway with one API key whose `tenant_id` is `core`.
Merchants never talk to the gateway. One tenant means one event cursor instead of one per
merchant, and one key to rotate. Merchant attribution travels in the gateway operation's
`metadata` and in a deterministic `externalId`.

**D5. The ledger is append-only with database-enforced invariants.**
No `UPDATE` or `DELETE` on journal tables. Corrections are reversing entries. A deferred
constraint trigger asserts debits equal credits per entry. `UPDATE` and `DELETE` are
revoked from `mulapay_core_rw` on those tables.

**D6. Dashboard sessions are implemented in-house.**
A payments platform needs its own control over session revocation, step-up auth, MFA
enforcement and the audit trail that ties an action to a session. An external IdP would
sit outside that trail.

**D7. Vitest, with Testcontainers.**
Matches the gateway's test tooling, and ledger invariants have to be tested against a
real Postgres rather than a mock.

---

## 3. The gateway contract

This section is the authoritative summary of how core talks to the gateway. The source is
`provider_gateway/docs/CORE_API_INTEGRATION.md`; read it too.

### 3.1 Base configuration

```
GATEWAY_BASE_URL=http://gateway:3000
GATEWAY_API_KEY=<key issued for tenant "core">
GATEWAY_API_KEY_HEADER=X-API-Key
GATEWAY_TENANT_ID=core
```

### 3.2 Endpoints core calls

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/payment/:providerId/collection` | Start an inbound payment |
| POST | `/api/v1/payment/:providerId/disbursement` | Start an outbound payout |
| POST | `/api/v1/payment/:providerId/refund` | Start a refund |
| GET | `/api/v1/payment/:providerId/balance` | Provider float balance |
| GET | `/api/v1/transaction/:referenceId` | Operation plus its logs |
| GET | `/api/v1/transaction/by-external-id/:externalId` | Lookup by core's own key |
| GET | `/api/v1/transaction` | List operations (filters, offset pagination, max limit 100) |
| GET | `/api/v1/events?afterId=&limit=&lagSeconds=` | Event stream (fallback event source) |
| GET | `/api/v1/health`, `/api/v1/health/ready` | Liveness and readiness |

`providerId` is one of `mtn`, `airtel`, `flutterwave`.

### 3.3 Request rules the gateway enforces (a 400 if broken)

- **Amounts are decimal strings**, never JSON numbers. Pattern `^[0-9]+(\.[0-9]{1,4})?$`.
- **Zero-decimal currencies take whole numbers only**: `UGX`, `RWF`, `KRW`, `JPY`, `VND`.
  Send `"1000"`, not `"1000.00"`.
- **Phone numbers need a `+` country code**: `"+256700000000"`.
- **The currency must be supported by the chosen provider.** MTN: UGX, GHS, XOF, XAF, ZMW.
  Airtel: UGX, KES, TZS, RWF, ZMW, MWK, NGN. Flutterwave: NGN, GHS, KES, UGX, TZS, ZAR,
  RWF, ZMW, XOF, XAF, USD, EUR, GBP.
- **`externalId` is required on refunds**, otherwise a retry becomes a second refund.
- Amounts come back padded to `decimal(15,4)`: `"1000"` returns as `"1000.0000"`.
  Compare numerically, never as strings.

Core must validate all of this **before** calling the gateway, so a bad request never
leaves core.

### 3.4 `externalId` scheme

`externalId` is core's idempotency key at the gateway and is unique per
(tenant, provider, operationType). Core uses a deterministic scheme so a retry always
reuses the same key:

| Operation | Pattern | Example |
| --- | --- | --- |
| Collection | `pay_{paymentId}` | `pay_01JBX7...` |
| Disbursement | `po_{payoutId}` | `po_01JBX8...` |
| Refund | `rf_{refundId}` | `rf_01JBX9...` |

An attempt counter is never appended. Retrying the same business operation must reuse the
same `externalId`; a new `externalId` is a new movement of money.

Pass `{ merchantId, environment, coreTransactionId }` in the gateway request's `metadata`.

### 3.5 Responses core must handle

| Status | Meaning | Core behaviour |
| --- | --- | --- |
| 201 | Accepted by the provider, body carries `referenceId` and `status` | Record `referenceId`, set transaction to `processing` (or terminal if the status is already terminal) |
| 200 | Duplicate `externalId`, existing operation returned | Treat as the same operation, do not create a second one |
| 400 | Validation failure | Fail the transaction with a `validation_error`, no ledger movement. This is a core bug, so alert |
| 401 / 403 | Core's gateway key is bad or provider access is denied | Page on-call. Do not retry in a loop |
| 404 | Provider unknown or disabled | Mark the route unavailable, try the next route in the routing policy |
| 409 | `externalId` reused with different parameters | A core bug. Fail the request, alert, never retry |
| 429 | Provider rate limited | Back off with jitter, retry up to the budget |
| 504 | **Outcome unknown.** Body carries `operationId`, `externalId`, `referenceId`, `status: "unknown"` | Set the transaction to `processing`, store the identifiers, **post nothing to the ledger**, and wait for a reconciliation event. Never retry with a new `externalId` |
| 5xx | Gateway failure | Retry with backoff on the same `externalId`; after the budget, set to `processing` and leave it to the chase job |

A timeout from core's own HTTP client is as ambiguous as a 504 and gets identical
treatment.

### 3.6 The event stream

Every status transition appends one row to `public.operation_events` in the same
transaction as the status change. The table is the contract. Columns:

```
id                bigserial   -- the cursor, monotonic
event_id          uuid        -- stable dedupe key
operation_id      uuid
tenant_id         text
provider_id       text
operation_type    text        -- collection | disbursement | refund
external_id       text
reference_id      text null
provider_transaction_id text null
status            text
previous_status   text
amount            decimal(15,4)
currency          char(3)
reason            text null
source            text        -- provider_response | callback | reconciliation
occurred_at       timestamptz
```

Read it with:

```sql
SELECT * FROM public.operation_events
 WHERE tenant_id = $1
   AND id > $2
   AND occurred_at <= now() - interval '2 seconds'
 ORDER BY id ASC
 LIMIT $3;
```

**The 2-second lag is mandatory.** Event ids are assigned at insert but only become
visible at commit, so a lower id can appear after a higher one. Do not reduce it.

**Delivery is at-least-once. Dedupe on `event_id`.**

### 3.7 Gateway status to core state

| Gateway status | Terminal | Core transaction state | Ledger action |
| --- | --- | --- | --- |
| `pending` | no | `processing` | none |
| `unknown` | no | `processing` (flag `outcome_unknown`) | **none**, and never infer |
| `successful` | yes | `succeeded` | post the settlement entry |
| `failed` | yes | `failed` | release any hold, no movement |
| `expired` | yes | `expired` | release any hold, no movement |
| `cancelled` | yes | `cancelled` | release any hold, no movement |

`successful`, `failed`, `expired` and `cancelled` are final. The gateway never transitions
out of them, so core must reject any event that tries to move a transaction out of a
terminal state and raise a reconciliation exception instead.

### 3.8 Money conversion at the boundary

The gateway speaks `decimal(15,4)` strings. The core ledger speaks `bigint` minor units.
Conversion happens **only** in `src/integrations/gateway/money.ts`, driven by a
`core.currencies` table holding the ISO 4217 exponent:

```
UGX 0,  RWF 0,  KRW 0,  JPY 0,  VND 0
KES 2,  TZS 2,  NGN 2,  GHS 2,  ZAR 2,  ZMW 2,  MWK 2,
USD 2,  EUR 2,  GBP 2,  XOF 0,  XAF 0
```

`toMinor("1000.0000", "UGX") -> 1000n`. `toGatewayAmount(1000n, "UGX") -> "1000"`.
A conversion that would lose precision throws. Unit-test every supported currency in
both directions.

---

## 4. Architecture

### 4.1 Processes

Three deployable processes from one codebase and one image, selected by `APP_ROLE`:

| `APP_ROLE` | Entry point | Responsibility |
| --- | --- | --- |
| `api` | `src/main.api.ts` | HTTP only. No queue workers, no pollers. Scales horizontally |
| `worker` | `src/main.worker.ts` | BullMQ workers: webhook delivery, notifications, reports, settlement, AML screening, statement matching |
| `consumer` | `src/main.consumer.ts` | Gateway event consumer plus scheduled jobs. **Singleton**, guarded by a Postgres advisory lock |

The consumer holds a global cursor, so exactly one instance may apply events. It takes
`pg_try_advisory_lock(hashtext('core:gateway-event-consumer'))` at boot and exits if it
cannot. Running two API replicas and two workers is safe; running two consumers is not,
and the lock makes that impossible rather than merely discouraged.

### 4.2 API surfaces

| Prefix | Audience | Auth |
| --- | --- | --- |
| `/v1` | Merchant servers | API key (`sk_`), optional HMAC request signature |
| `/dashboard/v1` | Merchant dashboard | JWT, merchant-scoped |
| `/admin/v1` | Admin console | JWT, staff-scoped, MFA required |
| `/v1/health`, `/v1/health/ready`, `/metrics` | Infrastructure | Health unauthenticated, metrics bearer token |

Each surface is a separate Nest module tree with its own guards, its own controllers and
its own OpenAPI document. Domain services are shared; controllers are not. A merchant
controller must never be able to serve an admin route by accident.

### 4.3 Layering

```
controller  ->  application service  ->  domain service  ->  repository  ->  Drizzle
                      |                        |
                      v                        v
               outbox / queue            ledger posting
```

Rules:

- Controllers do validation, authorization and shape mapping. No business logic.
- Application services own the use case and the transaction boundary.
- Domain services own invariants (state machines, fee calculation, ledger rules) and are
  pure where possible so they can be unit-tested without a database.
- Repositories own SQL. No SQL anywhere else.
- **No outbound HTTP call inside a database transaction.** Ever. Commit, then call, or
  write to the outbox and let a worker call.

### 4.4 Project structure

```
core_api/
├── src/
│   ├── main.api.ts
│   ├── main.worker.ts
│   ├── main.consumer.ts
│   ├── app.module.ts
│   ├── config/
│   │   ├── env.schema.ts          # Zod schema, validated at boot, process exits on failure
│   │   └── configuration.ts
│   ├── common/
│   │   ├── auth/                  # guards, strategies, token service, session service
│   │   ├── authz/                 # CASL ability factories, policy decorators
│   │   ├── idempotency/           # interceptor + store
│   │   ├── ratelimit/             # Redis sliding-window guard
│   │   ├── errors/                # error catalogue, exception filter, envelope
│   │   ├── pagination/            # cursor encode/decode, list helpers
│   │   ├── money/                 # Money value object, currency registry
│   │   ├── ids/                   # UUID v7, prefixed public ids
│   │   ├── crypto/                # HMAC, AES-GCM envelope encryption, timing-safe compare
│   │   ├── audit/                 # audit interceptor + hash chain
│   │   ├── outbox/                # transactional outbox write + dispatcher
│   │   ├── logging/               # Pino config, redaction
│   │   ├── telemetry/             # OTel init, metrics registry
│   │   └── db/                    # pools (rw, ro, replica), unit of work, advisory locks
│   ├── db/
│   │   ├── schema/                # Drizzle schema, one file per domain
│   │   ├── migrations/
│   │   └── seeds/                 # chart of accounts, currencies, roles, fee plans
│   ├── integrations/
│   │   ├── gateway/               # client, money conversion, routing, event source
│   │   ├── storage/               # S3 presigning
│   │   ├── email/                 # provider adapter
│   │   ├── sms/                   # provider adapter
│   │   ├── push/                  # FCM adapter
│   │   └── sanctions/             # screening adapter
│   ├── modules/
│   │   ├── payments/
│   │   ├── collections/
│   │   ├── disbursements/
│   │   ├── refunds/
│   │   ├── transactions/
│   │   ├── ledger/
│   │   ├── accounts/
│   │   ├── balances/
│   │   ├── holds/
│   │   ├── reconciliation/
│   │   ├── settlement/
│   │   ├── merchants/
│   │   ├── developer/             # public API meta, request logs, sandbox
│   │   ├── api-keys/
│   │   ├── webhooks/
│   │   ├── reports/
│   │   ├── notifications/
│   │   ├── kyc/
│   │   ├── aml/
│   │   ├── complaints/
│   │   ├── incidents/
│   │   ├── audit/
│   │   └── operations/
│   ├── surfaces/
│   │   ├── public/                # /v1 controllers
│   │   ├── dashboard/             # /dashboard/v1 controllers
│   │   └── admin/                 # /admin/v1 controllers
│   ├── jobs/                      # BullMQ processors and schedules
│   └── consumers/
│       └── gateway-events/        # poller, dispatcher, per-type handlers
├── test/
│   ├── integration/
│   ├── e2e/
│   ├── property/                  # ledger invariant tests
│   └── load/                      # k6 scripts
├── docs/
├── drizzle.config.ts
├── Dockerfile
├── docker-compose.yml
├── docker-compose.prod.yml
├── vitest.config.ts
├── .env.example
└── README.md
```

Each module folder holds `*.module.ts`, `*.service.ts`, `*.repository.ts`, `dto/`,
`domain/` and `*.spec.ts` beside the code it tests.

### 4.5 Every module gets the same treatment

For every one of the 23 domains, deliver: Drizzle schema plus migration, repository,
domain service with its invariants, application service, Zod DTOs, controllers on the
surfaces that need it, CASL rules, audit coverage on state changes, emitted events where
other modules care, OpenAPI documentation, unit tests and integration tests. A module is
not done until all of that exists.

---

## 5. Data model

All core tables live in the `core` schema. Conventions:

- `id uuid primary key default` UUID v7 generated in the app, not the database.
- Public identifier in a separate `ref` column, unique, prefixed (`pay_`, `po_`, ...).
  Public identifiers are what APIs return; raw UUIDs stay internal.
- `created_at timestamptz not null default now()`, `updated_at timestamptz` maintained by
  a trigger.
- Money: `amount_minor bigint not null` plus `currency char(3) not null`. Never a float,
  never a bare `numeric` for money in core tables.
- `merchant_id uuid` on every merchant-scoped table, indexed first in composite indexes.
- `environment text not null` (`test` | `live`) on everything a merchant can create.
  Test and live data share tables and are separated by this column plus a check in every
  repository method. Test data never touches live ledger accounts.
- Soft delete only where a dashboard needs an undo. Financial records are never deleted.

### 5.1 Partitioning

Declaratively partition by `created_at`, monthly, with `pg_partman` or a scheduled job
that creates the next three months ahead:

`transactions`, `journal_entries`, `journal_lines`, `audit_logs`, `webhook_deliveries`,
`notification_deliveries`, `api_request_logs`, `gateway_events`.

Every query against a partitioned table must carry a `created_at` range or a primary key,
so the planner can prune. Enforce this in the repository layer, not by hoping.

### 5.2 Core tables by domain

**Identity and merchants**

```
merchants            ref, legal_name, trading_name, country, default_currency, status
                     (draft|pending_kyc|active|suspended|closed), kyc_level, risk_rating,
                     fee_plan_id, settlement_cycle_id, mcc, website, support_email, metadata
merchant_profiles    merchant_id, registration_number, tin, incorporation_date,
                     business_type, address (jsonb), directors (jsonb)
merchant_limits      merchant_id, currency, per_txn_max_minor, daily_volume_max_minor,
                     monthly_volume_max_minor, payout_per_txn_max_minor, daily_payout_max_minor
merchant_settings    merchant_id, key, value (jsonb)        -- per-merchant config
users                email (citext unique), password_hash, name, phone, status,
                     mfa_secret_enc, mfa_enabled, last_login_at, failed_login_count,
                     locked_until, type (staff|merchant_user)
merchant_members     merchant_id, user_id, role, status, invited_by, joined_at
invitations          merchant_id, email, role, token_hash, expires_at, accepted_at
sessions             user_id, refresh_token_hash, family_id, device, ip, user_agent,
                     expires_at, revoked_at, revoked_reason
roles / permissions  role, permission, description      -- seeded, editable by admin
fee_plans            name, description, is_default, version, active
fee_plan_rules       fee_plan_id, transaction_type, provider, currency, channel,
                     percent_bps, fixed_minor, min_minor, max_minor, tier_from_minor
```

**Money movement**

```
transactions         ref, merchant_id, environment, type
                     (payment|payout|refund|fee|adjustment|transfer|settlement),
                     status, amount_minor, fee_minor, net_minor, currency,
                     provider, channel, gateway_operation_id, gateway_external_id,
                     gateway_reference_id, provider_transaction_id,
                     customer_id, parent_transaction_id, failure_code, failure_reason,
                     outcome_unknown bool, initiated_at, completed_at, metadata, created_at
payments             ref, transaction_id, merchant_id, environment, amount_minor,
                     currency, status, channel (mobile_money|card|bank),
                     payment_method (jsonb, encrypted PII), customer_id, description,
                     statement_descriptor, return_url, payment_link_id,
                     checkout_session_id, idempotency_key, expires_at, metadata
payment_links        ref, merchant_id, amount_minor (nullable for open amount), currency,
                     title, description, slug unique, active, max_uses, used_count,
                     expires_at, success_url
checkout_sessions   ref, merchant_id, payment_id, status, expires_at, client_secret_hash
payouts              ref, transaction_id, merchant_id, environment, amount_minor, currency,
                     destination (jsonb, encrypted), status, purpose, batch_id,
                     requires_approval, approved_by, approved_at, rejected_reason,
                     idempotency_key, metadata
payout_batches       ref, merchant_id, status, total_amount_minor, currency, item_count,
                     succeeded_count, failed_count, created_by, approved_by
refunds              ref, transaction_id, payment_id, merchant_id, amount_minor, currency,
                     status, reason, requested_by, approved_by, approved_at,
                     idempotency_key, metadata
customers            ref, merchant_id, name, email_enc, email_hmac, phone_enc, phone_hmac,
                     country, risk_flags, metadata
```

**Ledger, accounts, balances, holds**

```
currencies           code pk, exponent, name, is_zero_decimal
accounts             ref, code unique, name, type (asset|liability|equity|revenue|expense),
                     normal_balance (debit|credit), currency, merchant_id (nullable),
                     provider (nullable), purpose, is_system, active
account_balances     account_id, currency, posted_debits_minor, posted_credits_minor,
                     version, updated_at      -- pk (account_id, currency)
journal_entries      ref, idempotency_key unique, merchant_id (nullable), currency, kind,
                     description, transaction_id (nullable), source
                     (payment|payout|refund|fee|settlement|adjustment|reversal),
                     reverses_entry_id, posted_at, created_by, created_at
journal_lines        entry_id, line_no, account_id, direction (debit|credit),
                     amount_minor, currency, merchant_id, metadata, created_at
holds                ref, merchant_id, account_id, currency, amount_minor,
                     state (active|captured|released|expired), reason, transaction_id,
                     expires_at, captured_at, released_at, idempotency_key
merchant_balances    (view) merchant_id, currency, posted_minor, held_minor,
                     pending_minor, available_minor, reserved_minor
```

**Settlement and reconciliation**

```
settlement_cycles    name, schedule (cron), currency, delay_days, cutoff_time, timezone,
                     min_payout_minor, active
settlement_batches   ref, merchant_id, cycle_id, currency, period_start, period_end,
                     gross_minor, fee_minor, refund_minor, reserve_minor, net_minor,
                     status (draft|pending_approval|approved|releasing|paid|failed|cancelled),
                     approved_by, released_at, payout_transaction_id
settlement_items     batch_id, transaction_id, amount_minor, fee_minor, net_minor, kind
rolling_reserves     merchant_id, currency, percent_bps, hold_days, active
reserve_entries      merchant_id, currency, amount_minor, hold_until, released_at,
                     settlement_batch_id
reconciliation_runs  ref, kind (gateway_gap|ledger_integrity|provider_statement|balance_proof),
                     scope, period_start, period_end, status, started_at, finished_at,
                     checked_count, matched_count, exception_count, summary (jsonb)
reconciliation_exceptions
                     run_id, kind, severity, transaction_id, gateway_operation_id,
                     expected (jsonb), actual (jsonb), status (open|investigating|resolved|
                     written_off), assigned_to, resolution, resolved_by, resolved_at
provider_statements  provider, period_start, period_end, file_key, row_count,
                     total_minor, currency, uploaded_by, status
provider_statement_rows
                     statement_id, provider_ref, amount_minor, currency, occurred_at,
                     raw (jsonb), matched_transaction_id, match_status
```

**Gateway integration**

```
gateway_events       gateway_event_id uuid unique, gateway_id bigint, operation_id,
                     operation_type, external_id, reference_id, status, previous_status,
                     amount, currency, reason, source, occurred_at,
                     received_at, processed_at, apply_status (applied|skipped|failed),
                     apply_error, attempts
consumer_cursors     name pk, position bigint, updated_at, holder, heartbeat_at
gateway_requests     transaction_id, provider, operation_type, external_id,
                     http_status, latency_ms, error_code, attempt, request_id, created_at
```

**Developer platform**

```
api_keys             ref, merchant_id, environment, key_id unique, secret_hash, name,
                     scopes text[], ip_allowlist cidr[], rate_limit_rpm,
                     last_used_at, expires_at, revoked_at, revoked_by, created_by
webhook_endpoints    ref, merchant_id, environment, url, description,
                     enabled_events text[], secret_enc, status (active|disabled|
                     auto_disabled), failure_count, last_success_at, last_failure_at
webhook_deliveries   endpoint_id, event_id, attempt, status (pending|succeeded|failed|
                     exhausted), http_status, response_ms, response_body_excerpt,
                     error, next_attempt_at, created_at
merchant_events      ref, merchant_id, environment, type, resource_type, resource_id,
                     payload (jsonb), created_at      -- the merchant-visible event log
outbox               aggregate_type, aggregate_id, event_type, payload (jsonb),
                     available_at, attempts, locked_at, locked_by, published_at,
                     last_error, created_at
api_request_logs     merchant_id, environment, api_key_id, method, path, route,
                     status_code, latency_ms, request_id, idempotency_key, ip,
                     user_agent, error_code, created_at
idempotency_keys     merchant_id, scope, key, request_fingerprint, status
                     (in_flight|completed|failed), response_status, response_body (jsonb),
                     locked_at, expires_at      -- unique (merchant_id, scope, key)
```

**Compliance and support**

```
kyc_profiles         merchant_id, level (0..3), status (not_started|pending|in_review|
                     approved|rejected|expired), submitted_at, reviewed_by, reviewed_at,
                     rejection_reasons text[], expires_at, next_review_at
kyc_requirements     level, country, business_type, requirement_code, mandatory
kyc_documents        kyc_profile_id, type, file_key, file_hash, mime, size_bytes,
                     status (uploaded|verified|rejected), verified_by, rejection_reason,
                     expires_at, uploaded_at
kyc_verifications    kyc_profile_id, check_type (document|business_registry|
                     sanctions|address|bank_account), provider, status, result (jsonb),
                     performed_at
aml_screenings       subject_type (merchant|director|customer|counterparty), subject_id,
                     provider, lists text[], hit_count, highest_score, result (jsonb),
                     status (clear|potential_match|confirmed_match), screened_at
aml_rules            code unique, name, description, rule_type (velocity|amount_threshold|
                     structuring|geography|new_account|round_amount|counterparty_reuse),
                     params (jsonb), severity, action (flag|hold|block), enabled, version
aml_alerts           ref, rule_code, severity, merchant_id, transaction_id, customer_id,
                     score, status (open|investigating|escalated|closed_false_positive|
                     closed_confirmed), details (jsonb), assigned_to, due_at,
                     resolved_by, resolved_at, resolution_note
aml_cases            ref, merchant_id, status, severity, title, summary, opened_by,
                     assigned_to, alert_ids uuid[], outcome, str_filed_at, str_reference
aml_blocklist        entry_type (msisdn|email|account|bin|device|name), value_hmac,
                     reason, source, added_by, expires_at
complaints           ref, merchant_id, source (merchant|customer|admin), category,
                     subcategory, subject, description, transaction_id, customer_contact_enc,
                     priority, status (open|in_progress|awaiting_customer|escalated|
                     resolved|closed), sla_due_at, breached bool, assigned_to,
                     resolution, resolved_at, satisfaction_score
complaint_messages   complaint_id, author_type (merchant|admin|system|customer), author_id,
                     body, attachments (jsonb), internal bool, created_at
disputes             ref, transaction_id, merchant_id, kind (chargeback|inquiry|
                     pre_arbitration), amount_minor, currency, reason_code,
                     status, evidence_due_at, evidence (jsonb), outcome, hold_id
incidents            ref, title, severity (sev1..sev4), status (investigating|identified|
                     monitoring|resolved), impact, affected_services text[],
                     affected_merchants uuid[], started_at, detected_at, resolved_at,
                     commander, public bool, public_message
incident_updates     incident_id, status, body, public bool, author_id, created_at
incident_postmortems incident_id, summary, root_cause, timeline (jsonb),
                     action_items (jsonb), published_at
```

**Platform**

```
audit_logs           seq bigserial, actor_type (user|api_key|system|job), actor_id,
                     actor_label, merchant_id, action, resource_type, resource_id,
                     before (jsonb), after (jsonb), changed_fields text[], ip, user_agent,
                     request_id, trace_id, surface, outcome (success|denied|error),
                     prev_hash, hash, created_at
approvals            ref, kind, resource_type, resource_id, payload (jsonb),
                     requested_by, requested_at, required_approvals, status
                     (pending|approved|rejected|expired), expires_at
approval_decisions   approval_id, approver_id, decision, note, decided_at
feature_flags        key unique, description, enabled, rollout_percent,
                     merchant_allowlist uuid[], updated_by
routing_rules        priority, currency, country, channel, min_amount_minor,
                     max_amount_minor, msisdn_prefix, provider, weight, enabled
provider_status      provider, enabled, health (healthy|degraded|down), note,
                     success_rate_5m, updated_at
notifications        ref, recipient_type (user|merchant|admin_group), recipient_id,
                     channel, template_code, title, body, data (jsonb),
                     read_at, created_at
notification_templates
                     code unique, channel, locale, subject, body, variables (jsonb),
                     version, active
notification_preferences
                     user_id, template_code, channel, enabled
notification_deliveries
                     notification_id, channel, provider, provider_message_id, status,
                     error, attempts, sent_at, delivered_at, created_at
reports              ref, merchant_id (nullable for platform reports), type, format
                     (csv|xlsx|pdf|json), params (jsonb), status (queued|running|
                     ready|failed|expired), row_count, file_key, file_size,
                     requested_by, expires_at, error
report_schedules     report_type, params (jsonb), cron, timezone, recipients text[],
                     format, merchant_id, active, last_run_at, next_run_at
daily_merchant_rollups
                     merchant_id, date, currency, channel, provider,
                     payment_count, payment_minor, refund_count, refund_minor,
                     payout_count, payout_minor, fee_minor, success_count, failure_count
                     -- pk (merchant_id, date, currency, channel, provider)
```

### 5.3 Ledger invariants, enforced by the database

1. **Balanced entries.** A `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on
   `journal_lines` that, at commit, asserts for each touched entry that the sum of debit
   amounts equals the sum of credit amounts.
2. **Single currency per entry.** All lines of an entry share the entry's currency. FX is
   two entries bridged through an `fx_clearing` account, never one mixed entry.
3. **Positive amounts.** `CHECK (amount_minor > 0)`. Direction carries the sign.
4. **At least two lines.** Checked by the same deferred trigger.
5. **Append-only.** `BEFORE UPDATE OR DELETE` triggers on `journal_entries` and
   `journal_lines` that `RAISE EXCEPTION`, plus
   `REVOKE UPDATE, DELETE ON core.journal_entries, core.journal_lines FROM mulapay_core_rw`.
6. **Balance agreement.** `account_balances` is updated in the same transaction as the
   lines. A nightly job recomputes from `journal_lines` and raises a `sev1` incident on
   any mismatch.
7. **No negative available balance.** Enforced in the domain service, verified by a
   nightly check and by property tests. A merchant liability account going into a debit
   position is an exception, not a silent condition.
8. **Deadlock avoidance.** When an entry locks multiple `account_balances` rows, lock them
   in ascending `account_id` order, always.

### 5.4 Chart of accounts (seeded)

| Code | Type | Normal | Purpose |
| --- | --- | --- | --- |
| `1000:provider_clearing:{provider}` | asset | debit | Collected but not yet received from the provider |
| `1010:provider_float:{provider}` | asset | debit | Prefunded float held at the provider for payouts |
| `1100:bank:{account}` | asset | debit | Platform bank accounts |
| `1200:settlement_in_transit` | asset | debit | Settlement paid out, not yet confirmed |
| `1900:fx_clearing` | asset | debit | Bridge account for cross-currency entries |
| `2000:merchant_payable:{merchantId}` | liability | credit | What the platform owes the merchant |
| `2010:merchant_reserve:{merchantId}` | liability | credit | Rolling reserve withheld |
| `2100:refund_payable` | liability | credit | Refunds owed but not yet sent |
| `2200:tax_payable` | liability | credit | Withheld tax |
| `4000:fee_revenue` | revenue | credit | MulaPay fees |
| `4100:fx_revenue` | revenue | credit | FX spread |
| `5000:provider_fee_expense` | expense | debit | Fees charged by providers |
| `5100:loss_writeoff` | expense | debit | Reconciliation write-offs |
| `9000:suspense` | asset | debit | Unidentified money, must be cleared and alerts if non-zero over 24h |

### 5.5 Canonical ledger postings

Amounts are minor units. Nothing posts until the gateway event is terminal.

**Collection succeeded** (gross `G`, MulaPay fee `F`, provider fee `P`):

```
DR 1000:provider_clearing:{provider}   G
CR 2000:merchant_payable:{merchant}    G
DR 2000:merchant_payable:{merchant}    F
CR 4000:fee_revenue                    F
DR 5000:provider_fee_expense           P
CR 1000:provider_clearing:{provider}   P
```

**Payout succeeded** (amount `A`, fee `F`):

```
DR 2000:merchant_payable:{merchant}    A + F
CR 1010:provider_float:{provider}      A
CR 4000:fee_revenue                    F
```

**Refund succeeded** (amount `R`, fee policy decides whether `F` is returned):

```
DR 2000:merchant_payable:{merchant}    R
CR 1010:provider_float:{provider}      R
```

**Provider settles into the bank** (amount `S`):

```
DR 1100:bank:{account}                 S
CR 1000:provider_clearing:{provider}   S
```

**Merchant settlement released** (net `N`, reserve `V`):

```
DR 2000:merchant_payable:{merchant}    N + V
CR 2010:merchant_reserve:{merchant}    V
CR 1200:settlement_in_transit          N
```

then on confirmation:

```
DR 1200:settlement_in_transit          N
CR 1100:bank:{account}                 N
```

**Failed, expired or cancelled**: no posting at all. Release the hold and move on.

Every posting carries `idempotency_key = sha256(source + ':' + sourceId)`, where
`sourceId` is the gateway `event_id` for event-driven postings. Replaying an event
therefore conflicts on the unique index and is a no-op.

---

## 6. Module behaviour

### 6.1 Payments

A payment is the merchant-facing charge object. One payment maps to exactly one
`transactions` row of type `payment` and, once initiated, to one gateway collection
operation.

State machine:

```
created -> requires_action -> processing -> succeeded
                           \            \-> failed
                            \-> cancelled
created -> processing (when no customer action is needed)
processing -> expired
```

Rules:

- `POST /v1/payments` requires an `Idempotency-Key` header. Two identical calls return the
  same payment; a different body under the same key returns `409`.
- Core validates currency support, amount precision, merchant limits, merchant status and
  AML pre-checks **before** calling the gateway.
- Provider selection goes through the routing service (6.2). The caller may pin a provider
  with `payment_method.provider`, which is honoured if the route is enabled.
- The gateway call is synchronous with a bounded budget (default 30s, under the gateway's
  own 25 to 35s provider timeouts). A timeout leaves the payment `processing` with
  `outcome_unknown = true`.
- A terminal state is only ever set by the event consumer or the chase job, never by the
  initiating request handler, except for an outright gateway `400`.
- Payment links and checkout sessions create payments lazily, on first use. A link with
  `max_uses` reached or past `expires_at` is rejected.
- Payments expire via a scheduled job after `expires_at` (default 15 minutes for mobile
  money). Expiry emits an event and releases any hold.

### 6.2 Collections and routing

`routing_rules` are evaluated in `priority` order. A rule matches on currency, country,
channel, amount range and MSISDN prefix. Matching rules of equal priority are chosen by
`weight` (weighted random), so traffic can be split across providers.

A route is skipped when `provider_status.enabled` is false, when health is `down`, or when
the provider's circuit breaker is open. If no route matches, the payment fails with
`no_route_available` and the merchant gets a clear error.

Circuit breaker per (provider, operation): open after 5 consecutive ambiguous or 5xx
outcomes in 30 seconds, half-open after 15 seconds, closed after 3 successes. State lives
in Redis so all API replicas share it.

MSISDN handling: normalise to E.164 with a `+` prefix before anything else. An unparseable
number is a `400` from core, not from the gateway.

### 6.3 Disbursements

- Payouts debit `merchant_payable`, so **availability is checked and a hold is placed
  before the gateway is called.** The sequence is: validate, place hold in a transaction,
  commit, call the gateway, then on the terminal event capture the hold and post the entry.
- `requires_approval` is true when the amount exceeds `merchant_limits.payout_per_txn_max`
  or the merchant's configured approval threshold, or when the destination is new. A payout
  awaiting approval sits in `pending_approval` and no hold expires under it.
- Approval is maker-checker: the requester cannot approve. Approvers need MFA re-auth
  within the last 5 minutes.
- Batches: `POST /v1/payout-batches` accepts up to 10,000 items, validates all of them,
  then enqueues per-item processing. One bad item fails that item only. The batch exposes
  per-item status and a summary.
- A payout whose hold has been released but whose gateway outcome is still unknown is a
  reconciliation exception, not a retry candidate.

### 6.4 Refunds

- Only against a `succeeded` payment. Sum of refunds cannot exceed the payment amount;
  enforce with a row lock on the payment plus a check against posted refunds.
- Partial refunds allowed, multiple per payment allowed.
- Requires available merchant balance. If the balance is insufficient, the refund is
  rejected rather than taking the merchant negative, unless the merchant has
  `allow_negative_refund` set by an admin.
- MTN does not support refunds (`capabilities.refund: false`). Core must check the
  provider capability and return a clear `refund_not_supported` error, offering a payout as
  the alternative path. Do not attempt the gateway call.
- Refunds above a configurable threshold need approval.

### 6.5 Transactions

One read model over every money movement. Merchant-facing list endpoints use cursor
pagination keyed on `(created_at desc, id desc)`. Filters: type, status, currency,
provider, channel, date range, amount range, customer, reference. Full-text search on
`ref`, `gateway_external_id`, `provider_transaction_id` and customer HMAC columns.

`GET /v1/transactions/:id` includes the status timeline assembled from `gateway_events`
and `merchant_events`, never from gateway `transaction_logs` (which carry provider
payloads and are not core's to expose).

### 6.6 Ledger and accounts

The ledger service exposes exactly one write operation:

```ts
postEntry(tx, {
  idempotencyKey: string,
  currency: string,
  source: EntrySource,
  sourceId: string,
  merchantId?: string,
  transactionId?: string,
  description: string,
  lines: Array<{ accountCode: string; direction: 'debit' | 'credit'; amountMinor: bigint }>,
}): Promise<JournalEntry>
```

It validates balance before touching the database, resolves account codes to ids, locks
`account_balances` rows in ascending id order, inserts the entry and lines, updates the
balances, and returns. It is the only code path allowed to insert into journal tables.

Reversal is `reverseEntry(entryId, reason)`, which creates a new entry with every line's
direction flipped and `reverses_entry_id` set. Nothing is mutated.

Adjustments made by hand go through the approvals workflow, always, with no exception and
no threshold.

Reads: trial balance per currency, account statement with running balance, entry detail,
and an integrity endpoint that reports (a) entries where debits do not equal credits,
(b) accounts where `account_balances` disagrees with the sum of lines, (c) a non-zero
suspense account.

### 6.7 Balances and holds

```
posted    = f(normal_balance, posted_debits, posted_credits)
held      = sum(holds where state = 'active')
pending   = sum(transactions where type = 'payment' and status = 'processing')
reserved  = sum(reserve_entries where released_at is null)
available = posted - held - reserved
```

`pending` is informational and never spendable. `available` is what payouts, refunds and
settlement draw on.

Holds have an `expires_at`. A scheduled job expires stale active holds every minute and
emits an event. Capture and release are idempotent on `idempotency_key`. A hold can only
be captured once, and capturing a released hold is an error, not a silent no-op.

### 6.8 Reconciliation

Four independent runs, each schedulable and each producing a `reconciliation_runs` row
plus exceptions.

1. **Gateway gap.** Every 5 minutes. Finds core transactions in `processing` older than
   `RECON_STALE_MINUTES` (default 10) and asks the gateway
   `GET /api/v1/transaction/by-external-id/{externalId}`. Also finds gateway operations
   under tenant `core` with no matching core transaction, which would mean a lost record.
2. **Ledger integrity.** Hourly. Unbalanced entries, balance disagreement, negative
   merchant payable, non-empty suspense.
3. **Provider statement matching.** On statement upload. Matches
   `provider_statement_rows` to core transactions on provider reference, then on
   (amount, currency, date window). Produces unmatched-in-statement and
   unmatched-in-core exceptions.
4. **Balance proof.** Daily. Asserts that the sum of provider clearing and float accounts
   equals what the gateway reports via `GET /api/v1/payment/:providerId/balance`, within a
   configured tolerance, and that the sum of merchant payable equals the sum of merchant
   balances.

Exception handling is a queue with assignment, investigation notes and a resolution that
can be: matched manually, corrected with a reversing ledger entry, or written off to
`5100:loss_writeoff`. Every resolution is audited and a write-off needs approval.

A `sev1` incident is opened automatically on any ledger integrity failure.

### 6.9 Settlement

- A cycle runs on its cron. For each eligible merchant it computes, for the period:
  gross successful payments, minus refunds, minus fees, minus rolling reserve, minus
  anything held by a dispute or AML hold. Result is a `settlement_batches` row.
- Batches below `min_payout_minor` roll into the next cycle instead of creating a dust
  payout.
- `draft -> pending_approval -> approved -> releasing -> paid`, with `failed` and
  `cancelled` branches. Release creates a payout to the merchant's settlement destination
  and posts the settlement entry. Nothing is posted at `draft` or `approved`.
- Rolling reserve: `percent_bps` of gross withheld for `hold_days`, tracked in
  `reserve_entries` and released into the next eligible batch.
- A settlement run is idempotent per (merchant, cycle, period). Re-running produces no
  second batch.
- Settlement reports: per batch, an itemised statement the merchant can download.

### 6.10 Merchant management

Lifecycle: `draft -> pending_kyc -> active -> suspended -> closed`. Transitions are
admin-driven except `draft -> pending_kyc` (merchant submits KYC) and the automatic
`pending_kyc -> active` on KYC approval.

- `suspended` blocks new payments and payouts, allows refunds and settlement of already
  earned balance, and keeps read access.
- `closed` requires a zero balance or an explicit admin write-off, and blocks everything
  but reads.
- Fee plan changes are versioned and effective-dated. A change never alters fees already
  charged. Changing a merchant's plan needs approval.
- Limits are per currency and checked on every initiation against a Redis counter that is
  rebuilt from `daily_merchant_rollups` at startup and on a cron.
- Team roles for merchant users: `owner`, `admin`, `developer`, `finance`, `support`,
  `viewer`. Only `owner` can transfer ownership or close the account.

### 6.11 Developer API, API keys, webhooks

**Keys.** `mp_{live|test}_{keyId}_{secret}`. `keyId` is 16 chars and indexed; `secret` is
32 random bytes, and only its SHA-256 is stored. The full key is shown once, at creation,
and never again. Rotation creates a new key and schedules the old one for revocation after
a grace period the merchant chooses (0 to 7 days). Scopes gate route groups
(`payments:read`, `payments:write`, `payouts:write`, `balances:read`, ...). An optional
`ip_allowlist` is checked against the client IP derived from trusted proxies only.

**Request signing.** Optional per key, mandatory for `payouts:write` on live keys:

```
X-MulaPay-Timestamp: <unix seconds>
X-MulaPay-Signature: v1=<hex hmac-sha256>
signing string: timestamp + "." + method + "." + path + "." + sha256(rawBody)
```

Reject a timestamp skew over 300 seconds. Store the signature in Redis for the skew
window to reject replays.

**Webhooks.** Merchant-visible events are written to `merchant_events` inside the same
transaction as the state change, through the `outbox`. A worker reads the outbox and
enqueues one `webhook_deliveries` row per subscribed endpoint.

Signature header, Stripe-compatible in shape:

```
MulaPay-Signature: t=1699999999,v1=<hex hmac-sha256 of "t.payload">
```

Retry schedule: 0s, 30s, 2m, 10m, 1h, 6h, 24h (7 attempts), with jitter. Success is any
2xx within 10 seconds. An endpoint with 50 consecutive failures is `auto_disabled` and the
merchant is notified. Deliveries are replayable individually or in bulk by event type and
date range from the dashboard.

Event types, at minimum: `payment.created`, `payment.requires_action`,
`payment.succeeded`, `payment.failed`, `payment.expired`, `payment.cancelled`,
`refund.created`, `refund.succeeded`, `refund.failed`, `payout.created`,
`payout.pending_approval`, `payout.succeeded`, `payout.failed`, `balance.updated`,
`hold.created`, `hold.released`, `settlement.created`, `settlement.paid`,
`dispute.created`, `dispute.resolved`, `kyc.approved`, `kyc.rejected`,
`merchant.suspended`, `merchant.activated`.

**Request logs.** Every public API call writes an `api_request_logs` row asynchronously
(buffered in Redis, flushed in batches of 500 or every 2 seconds). Bodies are never stored;
only the error code and the idempotency key.

**Sandbox.** `test` environment keys never reach the gateway. A simulator resolves
payments deterministically from the amount's last two digits or from a
`metadata.simulate` value (`succeed`, `fail`, `timeout`, `expire`, `pending_then_succeed`),
emitting the same events on the same paths so merchants can test their webhook handling.

### 6.12 Reports and notifications

Reports are always asynchronous: `POST` returns `202` with a report `ref`, a worker
generates the file, uploads it to object storage, and the merchant downloads via a
presigned URL valid for 15 minutes. Report rows stream from the database with a server-side
cursor; nothing is buffered in memory. Files expire after 7 days.

Report types: transactions, payments, payouts, refunds, fees, balance statement, ledger
account statement, settlement statement, reconciliation exceptions, AML alerts, KYC status,
audit trail, merchant performance.

Notifications fan out from events through `notification_templates`. Channel selection
respects `notification_preferences`. Delivery is per channel with its own retry. Dedupe on
(recipient, template, resource) within a 5-minute window so a flapping state does not spam.
In-app notifications are read from the dashboard with an unread count endpoint.

### 6.13 KYC and AML

**KYC** is tiered. Level 0 is sign-up only (test keys, no live traffic). Level 1 needs
identity and contact verification (low live limits). Level 2 needs business registration,
TIN and a bank account (standard limits). Level 3 needs directors, UBO and source of funds
(high limits). `kyc_requirements` drives what the dashboard asks for, by country and
business type, so requirements are data and not code.

Documents upload direct to object storage with a presigned PUT; the API only ever sees the
object key, the SHA-256 and the content type. Allowed types are PDF, JPEG, PNG, max 10 MB.
Reject anything else by magic bytes, not by extension. Admin viewing of a document issues a
short-lived presigned GET and writes an audit row naming the document.

Approval moves the merchant to `active` and raises its limits, atomically with the KYC
status change. Rejection carries structured reasons the merchant can act on. Expiry
schedules a re-verification notice 30 days ahead.

**AML** runs in three places:

1. **Onboarding screening** of the merchant, its directors and its UBOs against sanctions
   and PEP lists. A confirmed match blocks activation and opens a case.
2. **Pre-transaction checks**, synchronous and fast (under 20 ms, Redis-backed): blocklist
   lookup, merchant status, hard limits. Anything slower belongs in step 3.
3. **Post-transaction monitoring**, asynchronous, on every terminal transaction event.
   Rules in `aml_rules` cover velocity (count or value in a window), amount thresholds,
   structuring (repeated amounts just under a threshold), geography, new-account bursts,
   round amounts and counterparty reuse. A rule fires an `aml_alerts` row with a severity
   and an action.

A `block` action places a hold on the merchant's balance and suspends further payouts; it
never reverses a completed transaction. Alerts have an SLA (`due_at`) and escalate when
breached. Cases aggregate alerts, carry an outcome, and can export an STR package as a
report. All of it is audited.

### 6.14 Complaints, incidents, audit, operations

**Complaints** carry a category-driven SLA (`sla_due_at`), a thread of messages with
internal-only notes, and an optional link to a transaction. Breached SLAs surface on an
admin queue and notify. Disputes and chargebacks are a separate table because they hold
money: opening a dispute places a hold for the disputed amount, and the outcome either
releases it or posts a reversing entry.

**Incidents** are internal records with severity, a timeline of updates, affected services
and merchants, and a postmortem. Updates marked `public` feed a status-page endpoint that
needs no auth and exposes no internal detail. Ledger integrity failures, suspense-account
drift, stuck-transaction thresholds and queue-depth thresholds open incidents
automatically.

**Audit** is append-only and hash-chained: `hash = sha256(prev_hash || canonical(row))`.
An interceptor captures actor, action, resource, before and after, changed fields, IP,
user agent, request id, trace id, surface and outcome for every state-changing request,
including denied ones. `GET /admin/v1/audit-logs/verify` walks the chain and reports the
first break. Audit rows are never updated or deleted, and the role has no rights to do so.

**Operations** is the back office: queue depth and failed-job retry, the consumer cursor
and its lag, stuck transactions, the suspense balance, feature flags, maintenance mode
(which rejects writes with `503` and a `Retry-After` while leaving reads working), provider
enable and disable, routing rule edits, and the approvals inbox. Every one of these writes
an audit row, and the destructive ones go through approvals.

---

## 7. Endpoint catalogue

Every list endpoint is cursor-paginated (`?limit=&cursor=`) unless noted. Every endpoint
is versioned, documented in OpenAPI, and covered by an integration test.

### 7.1 Public merchant API (`/v1`, API key)

```
GET    /v1/ping
GET    /v1/payment-methods                     # channels available for currency/country

POST   /v1/payments                            # Idempotency-Key required
GET    /v1/payments
GET    /v1/payments/:ref
POST   /v1/payments/:ref/cancel
GET    /v1/payments/:ref/timeline

POST   /v1/payment-links
GET    /v1/payment-links
GET    /v1/payment-links/:ref
PATCH  /v1/payment-links/:ref
POST   /v1/payment-links/:ref/deactivate

POST   /v1/checkout-sessions
GET    /v1/checkout-sessions/:ref
POST   /v1/checkout-sessions/:ref/expire

POST   /v1/refunds                             # Idempotency-Key required
GET    /v1/refunds
GET    /v1/refunds/:ref

POST   /v1/payouts                             # Idempotency-Key + signature required (live)
GET    /v1/payouts
GET    /v1/payouts/:ref
POST   /v1/payouts/:ref/cancel
POST   /v1/payout-batches
GET    /v1/payout-batches
GET    /v1/payout-batches/:ref
GET    /v1/payout-batches/:ref/items

GET    /v1/transactions
GET    /v1/transactions/:ref

GET    /v1/balances                            # per currency: posted, available, pending, held, reserved
GET    /v1/balance-transactions                # merchant-visible ledger movements
GET    /v1/holds

GET    /v1/settlements
GET    /v1/settlements/:ref
GET    /v1/settlements/:ref/items

POST   /v1/customers
GET    /v1/customers
GET    /v1/customers/:ref
PATCH  /v1/customers/:ref

GET    /v1/events                              # merchant event feed, cursor-based
GET    /v1/events/:ref

POST   /v1/webhook-endpoints
GET    /v1/webhook-endpoints
GET    /v1/webhook-endpoints/:ref
PATCH  /v1/webhook-endpoints/:ref
DELETE /v1/webhook-endpoints/:ref
POST   /v1/webhook-endpoints/:ref/rotate-secret

POST   /v1/disputes/:ref/evidence
GET    /v1/disputes
GET    /v1/disputes/:ref
```

### 7.2 Merchant dashboard API (`/dashboard/v1`, JWT)

```
POST   /dashboard/v1/auth/register
POST   /dashboard/v1/auth/login                # -> mfa_required | tokens
POST   /dashboard/v1/auth/mfa/verify
POST   /dashboard/v1/auth/mfa/enroll
POST   /dashboard/v1/auth/mfa/disable          # step-up required
POST   /dashboard/v1/auth/refresh
POST   /dashboard/v1/auth/logout
POST   /dashboard/v1/auth/forgot-password
POST   /dashboard/v1/auth/reset-password
POST   /dashboard/v1/auth/verify-email
POST   /dashboard/v1/auth/accept-invite
GET    /dashboard/v1/auth/me
GET    /dashboard/v1/auth/sessions
DELETE /dashboard/v1/auth/sessions/:id

GET    /dashboard/v1/merchant
PATCH  /dashboard/v1/merchant
GET    /dashboard/v1/merchant/settings
PATCH  /dashboard/v1/merchant/settings
GET    /dashboard/v1/merchant/limits
GET    /dashboard/v1/merchant/fee-plan

GET    /dashboard/v1/team
POST   /dashboard/v1/team/invites
GET    /dashboard/v1/team/invites
DELETE /dashboard/v1/team/invites/:id
PATCH  /dashboard/v1/team/:userId              # role change
DELETE /dashboard/v1/team/:userId

GET    /dashboard/v1/kyc
GET    /dashboard/v1/kyc/requirements
POST   /dashboard/v1/kyc/submit
POST   /dashboard/v1/kyc/documents/presign
POST   /dashboard/v1/kyc/documents             # confirm upload
DELETE /dashboard/v1/kyc/documents/:id

GET    /dashboard/v1/api-keys
POST   /dashboard/v1/api-keys
POST   /dashboard/v1/api-keys/:id/roll
DELETE /dashboard/v1/api-keys/:id

GET    /dashboard/v1/webhook-endpoints         # + CRUD mirroring /v1
GET    /dashboard/v1/webhook-deliveries
GET    /dashboard/v1/webhook-deliveries/:id
POST   /dashboard/v1/webhook-deliveries/:id/retry
POST   /dashboard/v1/webhook-deliveries/replay # by event type + date range
GET    /dashboard/v1/request-logs
GET    /dashboard/v1/request-logs/:id

GET    /dashboard/v1/payments | /payouts | /refunds | /transactions | /settlements
POST   /dashboard/v1/payouts                   # step-up auth
POST   /dashboard/v1/refunds                   # step-up auth
POST   /dashboard/v1/payouts/:ref/approve      # maker-checker
POST   /dashboard/v1/payouts/:ref/reject
GET    /dashboard/v1/balances
GET    /dashboard/v1/balance-transactions
GET    /dashboard/v1/holds

GET    /dashboard/v1/analytics/overview        # from daily_merchant_rollups only
GET    /dashboard/v1/analytics/volume
GET    /dashboard/v1/analytics/success-rate
GET    /dashboard/v1/analytics/channels

POST   /dashboard/v1/reports
GET    /dashboard/v1/reports
GET    /dashboard/v1/reports/:ref
GET    /dashboard/v1/reports/:ref/download
GET    /dashboard/v1/report-schedules          # + CRUD

GET    /dashboard/v1/notifications
GET    /dashboard/v1/notifications/unread-count
POST   /dashboard/v1/notifications/:id/read
POST   /dashboard/v1/notifications/read-all
GET    /dashboard/v1/notification-preferences
PATCH  /dashboard/v1/notification-preferences

POST   /dashboard/v1/complaints
GET    /dashboard/v1/complaints
GET    /dashboard/v1/complaints/:ref
POST   /dashboard/v1/complaints/:ref/messages
POST   /dashboard/v1/complaints/:ref/close

GET    /dashboard/v1/disputes
GET    /dashboard/v1/disputes/:ref
POST   /dashboard/v1/disputes/:ref/evidence

GET    /dashboard/v1/status                    # public incident feed
```

### 7.3 Admin API (`/admin/v1`, JWT + MFA)

```
POST   /admin/v1/auth/login | /mfa/verify | /refresh | /logout
GET    /admin/v1/auth/me
POST   /admin/v1/auth/step-up                  # re-auth for sensitive actions

GET    /admin/v1/merchants
POST   /admin/v1/merchants
GET    /admin/v1/merchants/:ref
PATCH  /admin/v1/merchants/:ref
POST   /admin/v1/merchants/:ref/activate
POST   /admin/v1/merchants/:ref/suspend
POST   /admin/v1/merchants/:ref/close
PATCH  /admin/v1/merchants/:ref/limits
PATCH  /admin/v1/merchants/:ref/fee-plan       # approval required
GET    /admin/v1/merchants/:ref/users
GET    /admin/v1/merchants/:ref/balances
GET    /admin/v1/merchants/:ref/activity
POST   /admin/v1/merchants/:ref/impersonate    # read-only token, 15 min, audited

GET    /admin/v1/fee-plans                     # + CRUD, versioned

GET    /admin/v1/kyc/queue
GET    /admin/v1/kyc/:merchantRef
POST   /admin/v1/kyc/:merchantRef/approve
POST   /admin/v1/kyc/:merchantRef/reject
POST   /admin/v1/kyc/:merchantRef/request-info
GET    /admin/v1/kyc/:merchantRef/documents/:id/view   # presigned, audited
POST   /admin/v1/kyc/:merchantRef/documents/:id/verify
GET    /admin/v1/kyc/requirements              # + CRUD

GET    /admin/v1/aml/alerts
GET    /admin/v1/aml/alerts/:ref
POST   /admin/v1/aml/alerts/:ref/assign
POST   /admin/v1/aml/alerts/:ref/escalate
POST   /admin/v1/aml/alerts/:ref/resolve
GET    /admin/v1/aml/cases
POST   /admin/v1/aml/cases
PATCH  /admin/v1/aml/cases/:ref
POST   /admin/v1/aml/cases/:ref/str            # generate STR package
POST   /admin/v1/aml/screenings                # ad-hoc screen
GET    /admin/v1/aml/rules
PATCH  /admin/v1/aml/rules/:code
GET    /admin/v1/aml/blocklist
POST   /admin/v1/aml/blocklist
DELETE /admin/v1/aml/blocklist/:id

GET    /admin/v1/accounts
GET    /admin/v1/accounts/:code
GET    /admin/v1/accounts/:code/statement
GET    /admin/v1/journal-entries
GET    /admin/v1/journal-entries/:ref
POST   /admin/v1/journal-entries/adjustment    # approval always required
POST   /admin/v1/journal-entries/:ref/reverse  # approval always required
GET    /admin/v1/trial-balance
GET    /admin/v1/ledger/integrity

GET    /admin/v1/balances
GET    /admin/v1/holds
POST   /admin/v1/holds                         # approval required
POST   /admin/v1/holds/:ref/release
POST   /admin/v1/holds/:ref/capture

GET    /admin/v1/transactions
GET    /admin/v1/transactions/:ref
POST   /admin/v1/transactions/:ref/refresh-status   # re-query the gateway
POST   /admin/v1/transactions/:ref/force-resolve    # approval required, audited heavily

GET    /admin/v1/payouts
POST   /admin/v1/payouts/:ref/approve
POST   /admin/v1/payouts/:ref/reject
POST   /admin/v1/payouts/:ref/retry
GET    /admin/v1/refunds
POST   /admin/v1/refunds/:ref/approve

GET    /admin/v1/reconciliation/runs
POST   /admin/v1/reconciliation/runs
GET    /admin/v1/reconciliation/runs/:ref
GET    /admin/v1/reconciliation/exceptions
GET    /admin/v1/reconciliation/exceptions/:id
POST   /admin/v1/reconciliation/exceptions/:id/assign
POST   /admin/v1/reconciliation/exceptions/:id/resolve
POST   /admin/v1/reconciliation/statements/presign
POST   /admin/v1/reconciliation/statements
GET    /admin/v1/reconciliation/statements/:id/rows

GET    /admin/v1/settlement/cycles             # + CRUD
GET    /admin/v1/settlement/payables
GET    /admin/v1/settlement/batches
POST   /admin/v1/settlement/batches            # run a cycle now
GET    /admin/v1/settlement/batches/:ref
GET    /admin/v1/settlement/batches/:ref/items
POST   /admin/v1/settlement/batches/:ref/approve
POST   /admin/v1/settlement/batches/:ref/release
POST   /admin/v1/settlement/batches/:ref/cancel

GET    /admin/v1/providers
PATCH  /admin/v1/providers/:id                 # enable, disable, health note
GET    /admin/v1/providers/:id/balance         # proxied from the gateway
GET    /admin/v1/routing-rules                 # + CRUD

GET    /admin/v1/complaints
GET    /admin/v1/complaints/:ref
POST   /admin/v1/complaints/:ref/assign
POST   /admin/v1/complaints/:ref/messages
POST   /admin/v1/complaints/:ref/escalate
POST   /admin/v1/complaints/:ref/resolve
GET    /admin/v1/complaints/sla-breaches
GET    /admin/v1/disputes
PATCH  /admin/v1/disputes/:ref
POST   /admin/v1/disputes/:ref/resolve

GET    /admin/v1/incidents
POST   /admin/v1/incidents
GET    /admin/v1/incidents/:ref
PATCH  /admin/v1/incidents/:ref
POST   /admin/v1/incidents/:ref/updates
POST   /admin/v1/incidents/:ref/resolve
POST   /admin/v1/incidents/:ref/postmortem

GET    /admin/v1/audit-logs
GET    /admin/v1/audit-logs/:seq
GET    /admin/v1/audit-logs/verify
POST   /admin/v1/audit-logs/export

GET    /admin/v1/ops/overview
GET    /admin/v1/ops/queues
POST   /admin/v1/ops/queues/:name/retry-failed
POST   /admin/v1/ops/queues/:name/pause
POST   /admin/v1/ops/queues/:name/resume
GET    /admin/v1/ops/consumer-cursors
POST   /admin/v1/ops/consumer-cursors/:name/rewind   # approval required
GET    /admin/v1/ops/stuck-transactions
GET    /admin/v1/ops/gateway-health
POST   /admin/v1/ops/gateway/replay-events
GET    /admin/v1/ops/feature-flags
PATCH  /admin/v1/ops/feature-flags/:key
POST   /admin/v1/ops/maintenance-mode
GET    /admin/v1/ops/approvals
GET    /admin/v1/ops/approvals/:ref
POST   /admin/v1/ops/approvals/:ref/approve
POST   /admin/v1/ops/approvals/:ref/reject

GET    /admin/v1/staff                         # + CRUD, disable, role assignment
GET    /admin/v1/roles                         # + permission editing
GET    /admin/v1/notification-templates        # + CRUD
POST   /admin/v1/notifications/broadcast
GET    /admin/v1/reports                       # platform-wide reports
POST   /admin/v1/reports
GET    /admin/v1/reports/:ref/download
```

### 7.4 Infrastructure

```
GET /v1/health                 # liveness, unauthenticated, no dependency checks
GET /v1/health/ready           # DB rw, DB ro, Redis, gateway readiness
GET /metrics                   # Prometheus, Authorization: Bearer <METRICS_TOKEN>
GET /v1/status                 # public incident feed, unauthenticated
GET /docs, /docs/openapi.json  # per surface, disabled in production unless authenticated
```

---

## 8. Cross-cutting requirements

### 8.1 Response envelope

Match the gateway so the whole platform reads the same way.

Success:

```json
{ "success": true, "data": { }, "meta": { "requestId": "...", "cursor": { } } }
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Available balance is below the payout amount",
    "details": { "available": "12000", "requested": "50000", "currency": "UGX" },
    "requestId": "01JBX...",
    "docUrl": "https://docs.mulapay.com/errors/insufficient_balance"
  }
}
```

Rules:

- One error catalogue in `src/common/errors/catalogue.ts`: code, HTTP status, message
  template, whether it is retryable, and whether details are safe to expose.
- 5xx responses never carry internal detail. Log the detail, return a generic message and
  the `requestId`, exactly as the gateway does.
- `details` is for machine-actionable fields only. No stack traces, no SQL, no provider
  payloads, no PII.
- Validation failures return `400` with a per-field list derived from the Zod error.
- `X-Request-Id` is accepted from the edge and echoed on every response.

### 8.2 Idempotency

Required on every public `POST` that moves money or creates a resource. The interceptor:

1. Reads `Idempotency-Key` (reject if missing on a required route, 1 to 255 chars).
2. Computes `fingerprint = sha256(canonicalJson(body) + method + path)`.
3. `SET idem:{merchantId}:{scope}:{key} <fingerprint> NX EX 86400` in Redis. If the key
   exists with a different fingerprint, return `409 IDEMPOTENCY_KEY_REUSED`.
4. Inserts an `idempotency_keys` row with status `in_flight` in the same transaction as
   the work, so durability does not depend on Redis.
5. On completion, stores the response status and body. A replay within 24 hours returns the
   stored response with `Idempotency-Replayed: true`.
6. A request that arrives while another is `in_flight` returns `409 REQUEST_IN_PROGRESS`
   with `Retry-After: 2`, rather than running twice.

Internal idempotency uses the same pattern with keys derived from the gateway `event_id`
or the business key, never from a timestamp or a random value.

### 8.3 Authentication

**API key path (hot).** Parse `mp_{env}_{keyId}_{secret}`. Look up by `keyId` in Redis
(`apikey:{keyId}`, TTL 60s). On a miss, read the database and cache. Compare the stored
SHA-256 against `sha256(secret)` with `crypto.timingSafeEqual`. Negative results are
cached for 30 seconds against enumeration. `last_used_at` is written to a Redis set and
flushed to the database every 10 seconds by the worker, never on the request path. Target:
under 1 ms at p99 when cached.

Revocation must be immediate: revoking a key publishes on a Redis channel and every
replica evicts its cache entry.

**JWT path.** Ed25519, `kid` in the header, keys from env (rotatable, two keys live at
once). Access token 10 minutes, carries `sub`, `type`, `merchantId`, `roles`, `sid`,
`mfa`, `amr`, `exp`. Verification is stateless with one Redis check against a revoked-`sid`
set. Refresh tokens are opaque 32-byte values, hashed in `sessions`, rotated on every use,
with a `family_id`: reuse of a rotated refresh token revokes the whole family and raises a
security alert. Cookie: `HttpOnly; Secure; SameSite=Strict; Path=/dashboard/v1/auth`.
CSRF via double-submit token on cookie-authenticated requests.

**Step-up.** Actions marked `@RequiresStepUp()` need `amr` to include a password or MFA
assertion in the last 5 minutes, otherwise `403 STEP_UP_REQUIRED`.

**Login protection.** Argon2id (`memoryCost: 19456, timeCost: 2, parallelism: 1`).
Progressive lockout after 5 failures (1, 2, 5, 15, 60 minutes), per account and per IP.
Identical timing and identical message for an unknown email and a wrong password.

### 8.4 Authorization

One CASL ability factory per actor type, built from the actor's roles and scopes. Every
controller method carries an explicit policy decorator; a route with no decorator fails
closed and the test suite asserts that no route is undecorated.

Merchant scoping is not optional and not a controller concern. Every repository method
that touches a merchant-scoped table takes a `merchantId` and adds it to the `WHERE`
clause. A test asserts that merchant A cannot read, modify or enumerate merchant B's
resources on any endpoint, and that a `test` key cannot see `live` data.

### 8.5 Rate limiting

Redis sliding window, applied in this order, with the first breach winning:

| Scope | Default |
| --- | --- |
| Per API key, writes | 100 / min (overridable per key) |
| Per API key, reads | 600 / min |
| Per merchant, payouts | 60 / min |
| Per IP, unauthenticated dashboard auth routes | 10 / min |
| Per account, login attempts | 5 / 15 min |
| Global per key, burst | token bucket, 20 capacity, 10/s refill |

`429` carries `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`. Limits are evaluated in a single Lua script so the check is one round
trip. Health and metrics endpoints are exempt.

### 8.6 Pagination

Cursor only on merchant-facing and admin lists. The cursor is base64url of
`{ "k": [createdAt, id], "d": "desc", "f": fingerprintOfFilters }`. Changing filters
invalidates the cursor with a `400`. `limit` defaults to 25 and caps at 100 (200 on admin).
Total counts are not returned on hot lists; where a count is genuinely needed, return an
estimate from `pg_class.reltuples` or a cached exact count, and label it. `OFFSET` is
permitted nowhere.

### 8.7 The gateway event consumer

```
loop:
  cursor = SELECT position FROM core.consumer_cursors WHERE name = 'gateway' FOR UPDATE
  events = read from gateway event source (batch 500, lag 2s)
  if events is empty: sleep(adaptive 250ms..2s); continue
  for each event:
     BEGIN
       INSERT INTO core.gateway_events (...) ON CONFLICT (gateway_event_id) DO NOTHING
       if not inserted: mark skipped; COMMIT; continue
       apply the handler for (operation_type, status)
       UPDATE core.consumer_cursors SET position = event.gateway_id, heartbeat_at = now()
     COMMIT
```

Non-negotiable properties:

- The insert, the handler and the cursor update are **one transaction**. A crash anywhere
  rolls all three back and the event is reprocessed.
- A handler failure does not block the stream forever: after 3 failed attempts the event is
  marked `apply_status = 'failed'`, a reconciliation exception is raised, the cursor
  advances, and a `sev2` incident opens. Head-of-line blocking on a payments platform is
  worse than a flagged exception.
- The handler is idempotent on its own: ledger postings key on the `event_id`, state
  changes are guarded by the current state.
- Terminal-state protection: an event trying to move a terminal transaction raises an
  exception and applies nothing.
- `heartbeat_at` is written every loop. Lag above `CONSUMER_LAG_ALERT_SECONDS` (default 60)
  fires an alert, and a stale heartbeat means the consumer is down.

Handlers by `(operation_type, status)`: 18 combinations, each with its own test.

### 8.8 The outbox

Any state change a merchant or another module cares about writes an `outbox` row in the
same transaction. A dispatcher in the worker process claims rows with
`FOR UPDATE SKIP LOCKED`, publishes to the relevant BullMQ queues, and marks them
published. Claims expire after 60 seconds so a dead worker's rows are retried. Retries use
exponential backoff and a row that exhausts attempts raises an operational alert. This is
the only way a webhook, notification or downstream job gets created. Nothing enqueues
directly from a request handler.

### 8.9 Queues

| Queue | Concurrency | Notes |
| --- | --- | --- |
| `outbox-dispatch` | 4 | Short, frequent |
| `webhook-delivery` | 32 | Per-endpoint serialisation via a BullMQ group key, so one endpoint's order is preserved |
| `notification-send` | 16 | Split by channel |
| `report-generate` | 2 | Memory-heavy, streamed |
| `settlement-run` | 1 | Serialised by design |
| `aml-screen` | 8 | |
| `statement-match` | 2 | |
| `rollup-aggregate` | 2 | |
| `gateway-chase` | 8 | Status re-query for stuck transactions |

Every job is idempotent, has `attempts` with exponential backoff, `removeOnComplete` with
a bounded keep, and a dead-letter path. Queue depth and oldest-job age are exported as
metrics, and a depth threshold opens an incident.

---

## 9. Performance requirements

Core API is the busy service. These are requirements, not aspirations.

### 9.1 Targets (steady state, p99)

| Operation | Target |
| --- | --- |
| API key authentication overhead | < 1 ms |
| `GET /v1/payments/:ref` | < 50 ms |
| `GET /v1/transactions` (25 rows, cursor) | < 120 ms |
| `GET /v1/balances` | < 30 ms |
| `POST /v1/payments` excluding the gateway call | < 80 ms |
| `GET /dashboard/v1/analytics/overview` | < 150 ms |
| Ledger posting (a 6-line entry) | < 25 ms |
| Event consumer throughput | > 500 events/s |
| Sustained API throughput per 2 vCPU replica | > 1,200 req/s on reads |

### 9.2 Rules that keep it there

1. **Fastify, with response schemas.** Serialization through `fast-json-stringify` on every
   route. A route without a response schema is an incomplete route.
2. **No reflection-heavy validation.** Zod schemas are built once at module load, not per
   request. No `class-transformer`.
3. **Three connection pools**: `rw` (primary, via PgBouncer), `ro` (primary, for gateway
   table reads), `replica` (read replica, for reports, analytics and admin lists). Pool
   sizes from env, defaulting to `max: 20` for `rw`. Because PgBouncer runs in transaction
   mode, prepared statements must be disabled or named consistently, and session-level
   state (`SET`, advisory locks, `LISTEN`) is forbidden on the `rw` pool. The consumer's
   advisory lock uses its own dedicated direct connection that bypasses PgBouncer.
4. **Never aggregate raw rows for a dashboard.** Every tile and chart reads
   `daily_merchant_rollups` or `account_balances`. The rollup job runs every 15 minutes for
   today and nightly for prior days.
5. **Cursor pagination everywhere.** No `OFFSET`, no `COUNT(*)` on hot paths.
6. **Partition pruning is mandatory.** Every query on a partitioned table carries a
   `created_at` bound. Repository methods take an explicit date range with a default
   window (90 days) rather than scanning all history.
7. **Index to the access pattern.** At minimum:
   `transactions (merchant_id, created_at desc, id desc)`,
   `transactions (merchant_id, status, created_at desc)`,
   `transactions (gateway_external_id)`,
   `transactions (ref)`,
   `journal_lines (account_id, created_at desc)`,
   `journal_lines (merchant_id, created_at desc)`,
   `webhook_deliveries (status, next_attempt_at)` partial on `status = 'pending'`,
   `outbox (available_at)` partial on `published_at is null`,
   `holds (merchant_id, state)` partial on `state = 'active'`,
   `api_keys (key_id)`, `api_keys (merchant_id, revoked_at)`.
   Verify every one with `EXPLAIN (ANALYZE, BUFFERS)` and commit the plans under
   `docs/query-plans/`.
8. **Cache what is read constantly and changes rarely**: API keys (60s), merchant config
   and status (60s), fee plans (300s), routing rules (60s), feature flags (30s), currency
   table (process lifetime). Invalidate by Redis pub/sub on write, not by waiting for TTL.
9. **Keep transactions short.** No HTTP, no S3, no queue publish inside one. Target under
   50 ms. A long transaction holds locks on `account_balances` and serialises other
   merchants.
10. **Batch the write-heavy, low-value paths**: `api_request_logs`, `last_used_at`,
    metrics counters. Buffer in Redis and flush in batches.
11. **No N+1.** List endpoints resolve relations with a single join or one batched
    follow-up query. A test fails a request that issues more than 4 queries.
12. **Payloads are bounded.** Body limit 256 KB. `metadata` capped at 20 keys and 4 KB.
    Batch endpoints cap at 10,000 items and process asynchronously.
13. **Shed load before falling over.** When the event loop lag exceeds 200 ms or queue
    depth exceeds a threshold, return `503` with `Retry-After` on non-critical reads while
    keeping payment initiation and webhook ingestion working.
14. **The worker and consumer never run in the API process.** No cron, no BullMQ worker, no
    polling loop behind an HTTP listener.

---

## 10. Observability

Mirror the gateway so one dashboard covers both services.

**Logging.** Pino JSON. Every line carries `requestId`, `trace_id`, `span_id`, `merchantId`
when known, `actorType`, `actorId`, `surface`. A redaction list covers `authorization`,
`x-api-key`, `x-mulapay-signature`, `cookie`, `set-cookie`, `password`, `secret`,
`token`, `mfa_secret`, `phone`, `email`, `account_number`, `pin`, `card`. Request bodies
are not logged above `debug`, and never in production. Reuse the gateway's redaction
approach in `src/common/logging/redaction.ts`.

**Tracing.** OpenTelemetry over OTLP/HTTP to the same collector. Instrument HTTP in and
out, Postgres, Redis and BullMQ. Propagate `traceparent` on every gateway call so a payment
is one trace across both services. Sample at `TELEMETRY_SAMPLE_RATIO`, with errors always
sampled.

**Metrics** at `GET /metrics`, bearer-token protected, registered only when
`METRICS_TOKEN` is set (same rule as the gateway).

| Metric | Labels |
| --- | --- |
| `core_http_request_duration_seconds` | surface, method, route, status_code |
| `core_payment_initiations_total` | provider, channel, currency, outcome |
| `core_transaction_state_transitions_total` | type, from, to, source |
| `core_gateway_request_duration_seconds` | operation, outcome (success/failure/ambiguous) |
| `core_gateway_event_lag_seconds` | (gauge) |
| `core_gateway_events_processed_total` | operation_type, status, apply_status |
| `core_ledger_entries_total` | source, currency |
| `core_ledger_posting_duration_seconds` | source |
| `core_ledger_integrity_failures` | kind (gauge) |
| `core_suspense_balance_minor` | currency (gauge) |
| `core_transactions_stuck` | type, age_bucket (gauge) |
| `core_merchant_available_balance_minor` | currency (gauge, aggregate only) |
| `core_webhook_delivery_duration_seconds` | outcome |
| `core_webhook_endpoints_auto_disabled_total` | |
| `core_queue_depth` / `core_queue_oldest_job_seconds` | queue |
| `core_idempotency_replays_total` | scope |
| `core_rate_limit_rejections_total` | scope |
| `core_auth_failures_total` | surface, reason |
| `core_reconciliation_exceptions_open` | kind, severity (gauge) |
| `core_aml_alerts_open` | severity (gauge) |
| `core_db_pool_connections` | pool, state |

**Alerts that must exist.** Ledger integrity failure above 0 (page immediately).
Suspense balance non-zero for over 1 hour. Event consumer lag above 60s or a stale
heartbeat. Stuck transactions above 0 for 15 minutes. Any gateway 401, 403 or 409. Queue
depth growth over 15 minutes. Webhook failure rate above 20%. AML alert SLA breach.
Auth failure spike. Replica lag above 30 seconds.

---

## 11. Security requirements

- **Secrets** come from the environment or a secret manager, validated by the Zod env
  schema at boot. The process exits on an invalid or missing secret. No secret in the
  database in plaintext: webhook signing secrets, MFA secrets and provider destination
  details are encrypted with AES-256-GCM using a DEK wrapped by a KMS key, with the key id
  stored alongside the ciphertext so rotation works.
- **PII** (customer phone, email, national ID, bank account) is stored encrypted with a
  separate HMAC-SHA256 column (keyed with a pepper) for exact-match search. Plaintext PII
  never appears in logs, traces, metrics labels, error details or webhook payloads beyond
  the last 4 characters where a merchant genuinely needs to identify a customer.
- **Transport**: TLS at the edge, HSTS, and core refuses to boot in production with
  `TRUST_PROXY` unset or set to a wildcard. Client IP comes only from trusted proxy CIDRs,
  exactly as the gateway does it.
- **Headers**: `@fastify/helmet` with a strict CSP on the docs route, `X-Frame-Options:
  DENY`, `X-Content-Type-Options: nosniff`, no `Server` header.
- **CORS**: explicit allowlist from env per surface. The public `/v1` API allows no browser
  origins at all; it is a server-to-server API and must say so.
- **Input**: everything through Zod. Reject unknown properties (`.strict()`). Validate
  uploads by magic bytes. No user input reaches a raw SQL string; raw SQL uses placeholders
  only, and a lint rule forbids template-literal SQL.
- **Output**: explicit response schemas. Never serialise an entity straight from the
  database. `tenant_id`, `request_fingerprint`, hashes, encrypted columns and internal ids
  are never exposed, following the gateway's `sanitizeOperation` pattern.
- **Enumeration**: public ids are random, not sequential. A 404 and a 403 on another
  merchant's resource return the same body.
- **Approvals (maker-checker)** required on: manual ledger adjustments and reversals
  (always), payouts above threshold, settlement release, merchant fee plan changes, limit
  increases, KYC approval, refunds above threshold, write-offs, consumer cursor rewind,
  force-resolve of a transaction, and feature flag changes in production.
- **Impersonation** issues a read-only token, lasts 15 minutes, cannot be used on write
  routes, and writes a prominent audit row at start and end.
- **Container**: distroless or alpine, non-root `node` user, read-only root filesystem,
  no shell in the production image, `npm ci --omit=dev`, dependencies pinned via
  `package-lock.json`, `npm audit` and a CVE scan in CI with the build failing on high.
- **Data retention**: `api_request_logs` 90 days, `webhook_deliveries` 90 days,
  `gateway_events` 1 year, `notification_deliveries` 180 days. Financial records,
  transactions, journals and audit logs are retained for 7 years and never deleted by a
  job. Retention runs by dropping partitions, not by `DELETE`.

---

## 12. Testing requirements

Vitest plus Testcontainers. The suite must be runnable with one command and must not need
a hand-prepared database.

| Layer | What it covers |
| --- | --- |
| Unit | Money conversion for every currency, fee calculation across tiers, every state machine transition including illegal ones, HMAC and signature verification, cursor encode and decode, CASL rules, routing rule evaluation, circuit breaker |
| Integration | Every endpoint against a real Postgres and Redis: happy path, validation failure, auth failure, cross-merchant access, rate limit, idempotent replay |
| Property | Ledger invariants under a few thousand randomised operation sequences: debits equal credits, balances equal the sum of lines, available balance never negative, reversal restores the prior balance exactly |
| Concurrency | 50 parallel identical payment requests produce one payment. Parallel refunds cannot exceed the payment amount. Parallel payouts cannot overdraw. Parallel hold captures succeed once |
| Consumer | Duplicate events, out-of-order ids, an event for an unknown transaction, an event for a terminal transaction, a crash between apply and cursor commit, a handler that throws three times |
| Gateway contract | Against a mocked gateway using the real response shapes from `provider_gateway/src/schemas/payment.ts`: 201, 200 duplicate, 400, 409, 429, 504, connection timeout. Assert core never retries a 504 with a new `externalId` |
| Security | No undecorated route, no endpoint leaking another merchant's data, no test key reading live data, PII absent from logs, audit row written for every state change, hash chain verifies |
| Load (k6) | The section 9.1 targets, plus a soak test asserting no memory growth and no connection leak over 30 minutes |

Coverage gates: 80% lines overall, **100% on `src/modules/ledger`, `src/common/money`,
`src/modules/balances` and `src/modules/holds`**. CI fails below either.

Also required: a `test/fixtures` factory per entity, a seeded chart of accounts, and a
deterministic clock so expiry and SLA tests are not flaky.

---

## 13. Repository conventions

```
npm run dev              # API with watch
npm run dev:worker
npm run dev:consumer
npm run build
npm run start            # APP_ROLE selects the process
npm run typecheck
npm run lint / lint:fix
npm run format / format:check
npm run test / test:watch / test:coverage
npm run test:integration
npm run test:load
npm run db:generate      # drizzle-kit generate
npm run db:migrate
npm run db:seed
npm run db:studio
npm run openapi:export   # writes docs/openapi/{public,dashboard,admin}.json
npm run seed:admin       # bootstrap the first admin user, prints a one-time password
npm run gateway:verify   # checks gateway connectivity, key validity and tenant id
```

- ESLint and Prettier configured to match `provider_gateway/.eslintrc.json` and
  `.prettierrc` so the two repositories read alike.
- Conventional commits. Husky pre-commit runs `lint-staged` plus `typecheck`;
  pre-push runs the unit suite.
- CI (GitHub Actions): typecheck, lint, unit, integration with service containers,
  coverage gate, `npm audit`, Docker build, image scan.
- No `any`. No `@ts-ignore` without a comment naming the reason. No `console.log`.
- Files under 400 lines; split a module before it sprawls.
- Every exported function that touches money, state or security carries a doc comment
  saying what invariant it upholds.

### Required documentation in `docs/`

| File | Content |
| --- | --- |
| `ARCHITECTURE.md` | Processes, layering, module map, request lifecycle |
| `GATEWAY_INTEGRATION.md` | How core consumes the gateway, the event consumer, failure handling |
| `LEDGER.md` | Chart of accounts, every posting pattern, invariants, how to investigate a discrepancy |
| `DATABASE.md` | Schema, roles, grants, partitioning, the migration workflow alongside the gateway |
| `API_PUBLIC.md` | The merchant-facing API guide, errors, idempotency, webhooks, signing |
| `SECURITY.md` | Auth models, key handling, encryption, approvals, threat notes |
| `OPERATIONS.md` | Runbooks: stuck transaction, consumer lag, ledger mismatch, suspense balance, webhook backlog, failed settlement, key compromise |
| `RECONCILIATION.md` | The four runs, exception handling, write-off procedure |
| `DEPLOYMENT.md` | Environments, migration order relative to the gateway, rollback |
| `query-plans/` | Committed `EXPLAIN ANALYZE` output for every hot query |

---

## 14. Build order

Do not build modules alphabetically. Each phase must be working, tested and committed
before the next begins.

**Phase 0 — Foundation.** Repository, TypeScript, NestJS on Fastify, Zod env validation,
Pino, OTel, metrics, Docker and compose, CI, health endpoints, the three pools, the `core`
schema with both database roles and their grants, Drizzle setup, the error catalogue and
exception filter, the response envelope, request id propagation, Vitest with Testcontainers.
Exit criteria: `GET /v1/health/ready` passes against containers and CI is green.

**Phase 1 — Identity and merchants.** Users, sessions, JWT with rotation, argon2, MFA,
login protection, CASL, merchants, merchant members, invitations, roles, the audit log with
its hash chain and the audit interceptor, admin bootstrap script. Exit criteria: an admin
can create a merchant, a merchant user can log in with MFA, and every action is audited and
chain-verified.

**Phase 2 — Ledger core.** Currencies, chart of accounts and seeds, `postEntry`,
`reverseEntry`, all database invariants and triggers, `account_balances`, balance
projection, holds with capture, release and expiry, the trial balance and integrity
endpoints. Exit criteria: the property suite passes, invariants are enforced by Postgres
(proven by a test that tries to violate each and expects an error), and 100% coverage on
the ledger modules.

**Phase 3 — Gateway integration.** The gateway HTTP client with timeouts, retries and the
circuit breaker, money conversion, the `GatewayEventSource` both ways, the consumer process
with its advisory lock, `gateway_events`, `consumer_cursors`, all 18 handlers, terminal
state protection, lag metrics, `gateway:verify`. Exit criteria: the contract suite and the
consumer suite pass, including the crash-between-apply-and-commit case.

**Phase 4 — Money movement.** Transactions, payments, collections and routing, refunds,
disbursements with holds and approvals, the fee engine, the idempotency interceptor, the
outbox, the gateway chase job, the approvals workflow. Exit criteria: a payment runs end to
end against a mocked gateway and lands correctly in the ledger; the concurrency suite
passes.

**Phase 5 — Developer platform.** API keys with caching and revocation, scopes, IP
allowlist, request signing, rate limiting, the public `/v1` surface, webhook endpoints and
signed delivery with retries and replay, `merchant_events`, request logs, the sandbox
simulator, the OpenAPI documents. Exit criteria: a merchant can integrate against the
sandbox with no platform involvement, and the security suite passes.

**Phase 6 — Settlement and reconciliation.** Settlement cycles, payables, batches with
approval and release, rolling reserve, all four reconciliation runs, the exception queue,
statement upload and matching, write-offs. Exit criteria: a full cycle runs and settles,
and a deliberately injected discrepancy is detected by the right run.

**Phase 7 — Compliance.** KYC levels, requirements as data, document upload and review,
AML screening, rules, alerts, cases, blocklist, STR export, dispute handling with holds.
Exit criteria: a merchant moves through KYC to `active` with limits raised atomically, and
each AML rule type fires on a crafted scenario.

**Phase 8 — Support and operations.** Complaints with SLAs, incidents with the public
status feed, notifications across all channels with templates and preferences, reports with
async generation and scheduling, the rollup job, dashboard analytics, the full operations
surface. Exit criteria: all three OpenAPI documents are complete, the runbooks in
`docs/OPERATIONS.md` are written and walked through, and the load targets in 9.1 are met.

**Phase 9 — Hardening.** Load and soak testing, query plan review and index tuning,
partition automation, retention jobs, chaos checks (kill the consumer mid-batch, kill
Postgres, make the gateway return 504 for a minute), a security review pass against
section 11, and dependency audit.

---

## 15. Environment variables

`.env.example` must list every one of these with a safe default or an empty placeholder and
a one-line comment. The Zod schema validates all of them at boot, and the process exits on
failure rather than starting half-configured.

```
# Process
NODE_ENV=development
APP_ROLE=api                      # api | worker | consumer
PORT=4000
HOST=0.0.0.0
TRUST_PROXY=                      # comma-separated CIDRs, required in production

# Database
DATABASE_URL=                     # mulapay_core_rw, via PgBouncer
DATABASE_RO_URL=                  # mulapay_core_ro, SELECT on gateway tables
DATABASE_REPLICA_URL=             # read replica for reports and analytics
DATABASE_DIRECT_URL=              # bypasses PgBouncer, for advisory locks and migrations
DB_POOL_MIN=2
DB_POOL_MAX=20
DB_STATEMENT_TIMEOUT_MS=15000
DB_IDLE_TX_TIMEOUT_MS=10000

# Redis
REDIS_URL=
REDIS_TLS=false

# Gateway
GATEWAY_BASE_URL=
GATEWAY_API_KEY=
GATEWAY_API_KEY_HEADER=X-API-Key
GATEWAY_TENANT_ID=core
GATEWAY_TIMEOUT_MS=30000
GATEWAY_MAX_RETRIES=2
GATEWAY_CIRCUIT_FAILURE_THRESHOLD=5
GATEWAY_CIRCUIT_RESET_MS=15000
GATEWAY_EVENT_SOURCE=database     # database | http
GATEWAY_EVENT_BATCH_SIZE=500
GATEWAY_EVENT_LAG_SECONDS=2
GATEWAY_EVENT_POLL_MS=500
CONSUMER_LAG_ALERT_SECONDS=60

# Auth
JWT_PRIVATE_KEY=                  # Ed25519 PEM
JWT_PUBLIC_KEY=
JWT_PREVIOUS_PUBLIC_KEY=          # for rotation
JWT_KID=
ACCESS_TOKEN_TTL=600
REFRESH_TOKEN_TTL=2592000
STEP_UP_WINDOW_SECONDS=300
MFA_ISSUER=MulaPay
SIGNATURE_TOLERANCE_SECONDS=300

# Encryption
KMS_KEY_ID=
DATA_ENCRYPTION_KEY=              # base64 32 bytes, or wrapped DEK when KMS is used
PII_HMAC_PEPPER=

# Rate limits
RATE_LIMIT_WRITE_PER_MIN=100
RATE_LIMIT_READ_PER_MIN=600
RATE_LIMIT_PAYOUT_PER_MIN=60

# Business policy
DEFAULT_CURRENCY=UGX
PAYMENT_EXPIRY_MINUTES=15
HOLD_DEFAULT_EXPIRY_MINUTES=60
PAYOUT_APPROVAL_THRESHOLD_MINOR=5000000
REFUND_APPROVAL_THRESHOLD_MINOR=5000000
SETTLEMENT_DEFAULT_DELAY_DAYS=1
SETTLEMENT_MIN_PAYOUT_MINOR=10000
ROLLING_RESERVE_BPS=0
RECON_STALE_MINUTES=10
RECON_GAP_INTERVAL_SECONDS=300
SUSPENSE_ALERT_HOURS=1

# Storage
S3_ENDPOINT=
S3_REGION=
S3_BUCKET_DOCUMENTS=
S3_BUCKET_REPORTS=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
PRESIGN_UPLOAD_TTL_SECONDS=900
PRESIGN_DOWNLOAD_TTL_SECONDS=900

# Notifications
EMAIL_PROVIDER=                   # ses | postmark | resend
EMAIL_API_KEY=
EMAIL_FROM=
SMS_PROVIDER=                     # africastalking | twilio
SMS_API_KEY=
SMS_SENDER_ID=
FCM_PROJECT_ID=
FCM_CREDENTIALS_JSON=

# Compliance
SANCTIONS_PROVIDER=               # opensanctions | complyadvantage
SANCTIONS_API_KEY=
SANCTIONS_LISTS=UN,OFAC,EU,UK,PEP

# CORS
CORS_DASHBOARD_ORIGINS=
CORS_ADMIN_ORIGINS=

# Observability
LOG_LEVEL=info
ENABLE_TELEMETRY=false
TELEMETRY_ENDPOINT=
TELEMETRY_SAMPLE_RATIO=1
METRICS_TOKEN=
ENABLE_API_DOCS=false
```

---

## 16. Definition of done

A phase is complete only when all of the following hold.

- [ ] `npm run typecheck`, `npm run lint` and `npm test` all pass with no warnings
      suppressed.
- [ ] Coverage gates met, including 100% on the ledger, money, balances and holds modules.
- [ ] Every new endpoint has an integration test for the happy path, a validation failure,
      an auth failure and a cross-merchant access attempt.
- [ ] Every state-changing endpoint writes an audit row, verified by a test.
- [ ] Every new table has a migration, indexes justified by a committed query plan, and a
      partition strategy if it grows per transaction.
- [ ] Every new money path has a ledger test proving debits equal credits and balances
      move as intended.
- [ ] Every new queue job is idempotent, with a test that runs it twice and asserts one
      effect.
- [ ] OpenAPI regenerated and committed.
- [ ] The relevant file in `docs/` updated, with a runbook entry if the feature can fail in
      production.
- [ ] No secret, token, PII or provider payload appears in any log line, metric label or
      error response.

---

## 17. Working instructions

1. Read section 3 and the gateway's `docs/CORE_API_INTEGRATION.md` before writing any code
   that touches the gateway. Getting the ambiguous-outcome handling wrong is how a payments
   platform loses money.
2. Build in the phase order of section 14. Do not start a phase while the previous one has
   failing tests.
3. When a requirement here conflicts with something you find in the gateway code, the
   gateway code wins for anything about gateway behaviour. Note the conflict in
   `docs/GATEWAY_INTEGRATION.md`.
4. When a decision in section 2 looks wrong once you are deep in the code, stop and raise
   it with the reasoning rather than substituting a different library quietly.
5. Never infer a payment outcome. If the gateway has not said `successful`, no money moves
   in the ledger. `unknown` means unknown.
6. Never write to a gateway-owned table, and never add a code path that could. The database
   role should make this impossible; if you find yourself needing to widen the grant, the
   design is wrong.
7. Prefer a rejected request over a wrong ledger entry. Failing loudly is cheap; a silent
   imbalance costs a reconciliation project.
8. Keep the two repositories consistent in style, logging shape, error envelope, health
   endpoints and metrics conventions. Someone will operate both at 3 a.m.



