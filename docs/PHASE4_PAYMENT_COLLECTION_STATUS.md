# Phase 4: Payment and Collection Services Status Report

**Generated**: 2024-11-17  
**Audit Scope**: P4-08 (Collections) and P4-09 (Payment Gateway Integration)  
**Purpose**: Identify gateway integration gaps before implementing money movement

---

## Executive Summary

**Payment infrastructure exists** but is **not connected to the Provider Gateway**. The following components are built:

✅ **Complete**:
- Payment state machine with full lifecycle service
- Transaction and payment tables with state guards
- Ledger posting logic for collections
- Payment creation flow with AML pre-check
- Sandbox simulation for test environment
- Idempotency protection
- Merchant events and outbox

❌ **Missing** (P4-08 and P4-09):
- Gateway collection submission (no `submitCollection` method exists)
- Routing service for provider selection
- Collection event handlers (6 stubs need implementation)
- Payment initiation flow to gateway after payment creation
- Merchant limits enforcement before payment submission
- Fee calculation service

**Collections module does not exist separately** — all collection logic is inside the payments module. The gateway integration is the primary gap.

---

## 1. Payment Service Implementation Status

### 1.1 What Exists

**File**: `src/modules/payments/payments.service.ts` (lines 1-244)

**Implemented operations**:
- ✅ `create()`: Creates payment record with idempotency protection
- ✅ `get()`: Retrieves single payment by ref
- ✅ `list()`: Paginated list with cursor-based pagination
- ✅ `timeline()`: Payment status history
- ✅ `cancel()`: Cancels payment (local only, no gateway interaction)

**What it does**:
- Creates payments in `created` status
- Validates merchant scope and environment
- Handles idempotency keys (24-hour replay window)
- Applies transitions through `PaymentLifecycleService`
- Records audit events
- Scopes all operations to merchant + environment

**What it does NOT do**:
- ❌ Submit payments to gateway after creation
- ❌ Select provider via routing rules
- ❌ Check merchant limits before creation
- ❌ Calculate fees
- ❌ Handle gateway responses (accepted/rejected/ambiguous)

### 1.2 Payment Creator

**File**: `src/modules/payments/payment-creator.ts` (lines 1-207)

**Responsibilities**:
- Creates transaction + payment atomically
- Validates payment amount and currency
- Normalizes and encrypts MSISDN
- Runs AML pre-check for live payments
- Generates fixed gateway external ID (`gatewayExternalIdFor(paymentRef)`)
- Emits `payment.created` event
- Queues sandbox simulation for test environment
- Records first transaction event (`created`)

**Key insight**: Payment stays in `created` status. Comment on line 10-11:
> "Nothing here talks to the gateway: the payment stays `created` until a later phase submits it."

**Gateway-ready**: The `gatewayExternalId` is set at creation time, so retried submissions cannot create duplicate collections (spec 3.4).

### 1.3 Payment Lifecycle Service

**File**: `src/modules/payments/payment-lifecycle.service.ts` (lines 1-344)

**Status**: ✅ **COMPLETE** — This is production-ready

**What it does**:
1. **Idempotent event application** per `eventKey`
2. **State machine enforcement** via `decideTransition(from, to)`
3. **Terminal state protection** — cannot change succeeded/failed/cancelled/expired
4. **Event verification** — checks amounts, currencies, provider IDs match
5. **Ledger posting** on success via `PostingService.postEntry()`
6. **Checkout session closure** when payment terminates
7. **Merchant event emission** (`payment.{status}`, `balance.updated`)
8. **AML monitoring trigger** for terminal states
9. **Database locking** in correct order: session → payment → transaction

**Posting logic** (lines 261-283):
- Uses `collectionPostingLines()` domain function
- Posts: DR provider_receivable, CR merchant_payable, DR fees
- Idempotency key: `ledgerIdempotencyKey('payment', sourceId)`
- Validates provider is set and recognized

**Critical invariants upheld**:
- ✅ Payments and transactions stay synchronized (database triggers)
- ✅ Posted entries are immutable
- ✅ Duplicate events return `duplicate` result
- ✅ Refused events return `rejected` with reason (for reconciliation)
- ✅ `outcome_unknown` does not resolve payment
- ✅ Success requires amount/currency/provider verification

**Gateway integration points** (what calls `apply()`):
- Payment cancel route (already wired)
- Gateway event consumer (P3-09 stubs, need P4-13)
- Chase job (P4-10, not built)
- Expiry sweep (P4-11, may exist)

---

## 2. Collection Handlers Status

**File**: `src/consumers/gateway-events/handlers/collection.handlers.ts` (lines 1-77)

**Status**: ❌ **STUBS ONLY** — 6 handlers created but not implemented

### 2.1 Handler Implementation Map

| Handler | Status | Lines | What's Missing |
|---------|--------|-------|----------------|
| `CollectionPendingHandler` | Stub | 19-24 | Verify payment is in `processing` state |
| `CollectionUnknownHandler` | Stub | 30-35 | Call `PaymentLifecycleService.apply()` with `outcome_unknown` |
| `CollectionSuccessfulHandler` | Stub | 41-46 | Call `PaymentLifecycleService.apply()` with `succeeded` signal |
| `CollectionFailedHandler` | Stub | 52-57 | Call `PaymentLifecycleService.apply()` with `failed` signal |
| `CollectionExpiredHandler` | Stub | 63-68 | Call `PaymentLifecycleService.apply()` with `expired` signal |
| `CollectionCancelledHandler` | Stub | 70-77 | Call `PaymentLifecycleService.apply()` with `cancelled` signal |

**Common pattern needed**:
```typescript
async handle(tx: Transaction, event: GatewayEvent): Promise<boolean> {
  // 1. Look up payment by event.externalId (gateway ref → payment ref)
  // 2. Map event to PaymentEventInput signal
  // 3. Call PaymentLifecycleService.apply(tx, paymentId, eventInput)
  // 4. Log result (applied/duplicate/rejected)
  // 5. Return true (commit) unless unrecoverable error
}
```

**Integration**: Handlers are registered in `GatewayEventHandlerRegistry` (Phase 3).

---

## 3. Gateway Client Status

**File**: `src/integrations/gateway/gateway-operations.client.ts`

### 3.1 What Exists

✅ **Port interface** (`gateway-operations.port.ts`, lines 1-126):
- `submitDisbursement(request)` — for payouts (Phase 6 uses this)
- `findByExternalId(externalId)` — status query for chase job
- `listOperations(query)` — bulk transaction list
- `getBalance(providerId, accountType, currency)` — provider balance check

✅ **Client implementation**:
- Circuit breaker integration
- Retry logic with exponential backoff (lines 29-34)
- Request recorder (Phase 3)
- Response parsing and validation
- Handles 429 rate limiting
- Ambiguous outcome detection (504, timeout, 5xx)

### 3.2 What's Missing

❌ **No `submitCollection` method** — Collections cannot be submitted to the gateway

**What needs to be added**:
1. Port interface addition:
   ```typescript
   export interface CollectionRequest {
     readonly environment: 'test' | 'live';
     readonly providerId: PaymentProvider;
     readonly externalId: string;  // payment ref
     readonly amountMinor: bigint;
     readonly currency: string;
     readonly payer: { readonly msisdn: string };
     readonly metadata: {
       readonly merchantId: string;
       readonly environment: 'test' | 'live';
       readonly coreTransactionId: string;
     };
   }

   export type CollectionResult =
     | { readonly kind: 'accepted'; readonly duplicate: boolean; readonly referenceId: string; readonly status: GatewayStatus; }
     | { readonly kind: 'rejected'; readonly reason: string; readonly httpStatus: number; }
     | { readonly kind: 'rate_limited'; readonly retryAfterMs: number | null; }
     | { readonly kind: 'ambiguous'; readonly referenceId: string | null; readonly httpStatus: number | null; };

   submitCollection(request: CollectionRequest): Promise<CollectionResult>;
   ```

2. Client implementation:
   - `POST /api/v1/payment/:providerId/collection`
   - Similar retry/circuit breaker logic as `submitDisbursement`
   - Map to `CollectionResult` discriminated union
   - Record request/response (already handled by recorder)

**Gateway endpoint** (from spec, not shown in existing code):
- Endpoint: `POST /api/v1/payment/{providerId}/collection`
- Body: `{ externalId, amount, currency, payer: { msisdn }, metadata }`
- Responses: 201 (accepted), 200 (duplicate), 400/409 (rejected), 429 (rate limited), 504/5xx (ambiguous)

---

## 4. Routing Service Status

**Status**: ❌ **DOES NOT EXIST**

### 4.1 Database Tables (Phase 8)

**Migration**: `0008_support_operations.sql` (lines 387-412)

✅ Tables exist:
- `routing_rules`: priority, weight, currency, country, channel, amount ranges, MSISDN prefix, provider, enabled
- `provider_status`: provider health tracking (healthy/degraded/down)

**Routing rules schema**:
```sql
CREATE TABLE "core"."routing_rules" (
  id uuid PRIMARY KEY,
  ref text NOT NULL,                      -- rrl_{ULID}
  priority integer NOT NULL,              -- 0-10000 (higher = first)
  currency char(3) NOT NULL,
  country text DEFAULT '*' NOT NULL,      -- '*' or ISO 3166-1 alpha-2
  channel text DEFAULT '*' NOT NULL,      -- '*', 'mobile_money', 'card', 'bank'
  min_amount_minor bigint,
  max_amount_minor bigint,
  msisdn_prefix text,                     -- '+260', '+265', etc.
  provider text NOT NULL,                 -- 'mtn', 'airtel', 'flutterwave'
  weight integer DEFAULT 100 NOT NULL,    -- 1-1000 (for random selection within priority)
  enabled boolean DEFAULT true NOT NULL,
  updated_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX routing_rules_lookup_idx 
  ON routing_rules(currency, priority) 
  WHERE enabled;
```

### 4.2 What Needs to Be Built

**Service**: `src/modules/routing/routing.service.ts`

**Method signature**:
```typescript
interface RouteSelection {
  readonly kind: 'selected';
  readonly provider: PaymentProvider;
  readonly ruleRef: string;
}

type RouteResult = RouteSelection | { readonly kind: 'no_route_available' };

selectRoute(params: {
  merchantId: string;
  operationType: 'collection' | 'disbursement' | 'refund';
  amountMinor: bigint;
  currency: string;
  channel: 'mobile_money' | 'card' | 'bank';
  msisdn?: string;
  pinnedProvider?: PaymentProvider;  // From payment_method.provider
}): Promise<RouteResult>;
```

**Algorithm** (from PHASE4_BREAKDOWN.md P4-02):
1. Check if provider is pinned by merchant (honor if enabled)
2. Query `routing_rules` WHERE:
   - `enabled = true`
   - `currency = :currency`
   - `channel IN ('*', :channel)`
   - `country = '*'` (or match merchant country later)
   - `min_amount_minor IS NULL OR :amount >= min_amount_minor`
   - `max_amount_minor IS NULL OR :amount <= max_amount_minor`
   - `msisdn_prefix IS NULL OR :msisdn LIKE msisdn_prefix || '%'`
3. Order by `priority DESC`
4. Group by priority, pick highest priority group
5. Within group: weighted random selection based on `weight` column
6. Check `provider_status`: skip if health = 'down'
7. Check `RedisCircuitBreaker.allow(provider)`: skip if open
8. Return selected provider or `no_route_available`

**Dependencies**:
- `ProviderStatusRepository` (or query via raw SQL)
- `RedisCircuitBreaker` (already exists, Phase 3)

**Integration points**:
- Called by `PaymentsService` before gateway submission
- Called by `PayoutsService` (P4-06)
- Called by `RefundsService` (P4-05)

---

## 5. Fee Engine Status

**Status**: ❌ **DOES NOT EXIST**

### 5.1 Database Tables

**Status**: ❌ Tables do not exist

**What's needed** (from PHASE4_BREAKDOWN.md P4-03):
```sql
CREATE TABLE "core"."fee_plans" (
  id uuid PRIMARY KEY,
  ref text NOT NULL,                    -- fpl_{ULID}
  name text NOT NULL,
  merchant_id uuid,                      -- NULL for platform plans
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "core"."fee_plan_rules" (
  id uuid PRIMARY KEY,
  fee_plan_id uuid NOT NULL REFERENCES fee_plans(id),
  operation_type text NOT NULL,         -- 'collection', 'disbursement', 'refund'
  currency char(3) NOT NULL,
  rule_type text NOT NULL,              -- 'fixed', 'percentage', 'minimum', 'maximum', 'tiered'
  value_bps integer,                     -- Basis points (1 bps = 0.01%)
  fixed_minor bigint,
  min_minor bigint,
  max_minor bigint,
  tier_thresholds jsonb,                 -- For tiered pricing
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
```

**Migration**: Needs `0014_fee_plans.sql` or added to `0013_payouts_refunds.sql`

### 5.2 Service Implementation

**What's needed**: `src/modules/fees/fee-calculation.service.ts`

**Method signature**:
```typescript
calculateFee(params: {
  operationType: 'collection' | 'disbursement' | 'refund';
  amountMinor: bigint;
  currency: string;
  merchantId: string;
}): Promise<bigint>;  // Returns feeMinor
```

**Requirements**:
- Use bigint arithmetic only (no floating point)
- Load fee plan for merchant (or default platform plan)
- Apply rules in order: percentage → fixed → min → max
- Idempotent: same inputs always produce same fee
- For now: **can start with 0 fees** and defer full engine

**Decision P4-D6**: Provider fee `P` = 0 until gateway provides it in events

---

## 6. Merchant Limits Enforcement

**Status**: ⚠️ **TABLES EXIST** (Phase 7) but enforcement logic not built for payments/payouts

### 6.1 Database Tables

✅ Tables exist (Migration `0007_compliance.sql`):
- `merchant_limits`: per-transaction, daily, monthly limits for collections and payouts
- `kyc_level_limits`: default limits per KYC level

**Schema**:
```sql
CREATE TABLE "core"."merchant_limits" (
  merchant_id uuid PRIMARY KEY,
  per_transaction_minor bigint NOT NULL,
  daily_minor bigint NOT NULL,
  monthly_minor bigint NOT NULL,
  payout_daily_minor bigint NOT NULL,
  payout_monthly_minor bigint NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);
```

### 6.2 What Needs to Be Built

**Service**: `src/modules/limits/merchant-limits.service.ts` (might exist partially in Phase 7)

**Methods needed**:
```typescript
checkTransaction(params: {
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  date: Date;
}): Promise<void>;  // Throws AppError('LIMIT_EXCEEDED') if over limit

checkPayout(params: {
  merchantId: string;
  amountMinor: bigint;
  currency: string;
  date: Date;
}): Promise<void>;
```

**Algorithm**:
1. Load `merchant_limits` for merchant (or fallback to `kyc_level_limits`)
2. Check per-transaction limit
3. Query sum of today's transactions (status = 'succeeded', same day)
4. Check daily limit
5. Query sum of this month's transactions
6. Check monthly limit
7. Throw `LIMIT_EXCEEDED` with details if any check fails

**Integration points**:
- Called by `PaymentsService.create()` or routing service
- Called by `PayoutsService.create()` (P4-06)

---

## 7. Payment Initiation Flow (P4-08 Core Gap)

### 7.1 Current Flow

**What happens today**:
1. `POST /v1/payments` → `PaymentsService.create()`
2. `PaymentCreator.create()` runs inside transaction:
   - AML pre-check
   - Create transaction + payment (status: `created`)
   - Emit `payment.created` event
   - If test env: queue sandbox simulation
3. Response: `201 Created` with payment object
4. **Payment stays in `created` status forever** (unless sandbox)

**Test environment**: Sandbox simulation (Phase 5) resolves payment based on `metadata.simulate` value.

**Live environment**: Payment never moves from `created` — **no gateway submission happens**.

### 7.2 What Needs to Be Added

**New flow** (after P4-08 completion):

**Inside transaction** (`PaymentsService.create()` or `PaymentCreator.create()`):
1. Validate payment method
2. **Check merchant limits** (P4-04)
3. **Select route** via `RoutingService` (P4-02)
4. **Calculate fee** via `FeeCalculationService` (P4-03, or 0 for now)
5. Create transaction + payment (status: `created`)
6. Emit `payment.created` event
7. **Commit transaction**

**After transaction commit** (outside `UnitOfWork.run()`):
8. **Submit to gateway** via `GatewayOperationsClient.submitCollection()`
9. **Handle gateway result**:
   - `accepted`: Update payment → `processing` (via `PaymentLifecycleService.apply()`)
   - `rejected`: Update payment → `failed` with failure code
   - `ambiguous`: Update payment → `processing` with `outcome_unknown = true`
   - `rate_limited`: Queue retry job or return 429 to merchant

**Critical**: Gateway call must happen **after** database commit (spec 3.4, 3.5). Never inside `UnitOfWork.run()`.

### 7.3 Alternative: Separate Submission Step

**Option B**: Keep creation separate from submission
1. `POST /v1/payments` creates payment in `created` status
2. Background job or separate route submits to gateway
3. Allows merchant to review payment before submission

**Decision needed**: Does creation immediately submit, or is submission deferred?

**Spec guidance** (from comment in `payment-creator.ts`, line 10):
> "Nothing here talks to the gateway: the payment stays `created` until a later phase submits it."

This suggests **deferred submission** was intended, but current implementation never submits at all.

**Recommendation**: For P4-08, implement **immediate submission after creation** for collections. Deferred submission can be added later if needed.

---

## 8. Missing Integration Components Summary

### 8.1 Services to Build

| Component | File Path | Dependencies | Priority |
|-----------|-----------|--------------|----------|
| Routing Service | `src/modules/routing/routing.service.ts` | `routing_rules`, `provider_status`, `RedisCircuitBreaker` | **P1** |
| Fee Calculation Service | `src/modules/fees/fee-calculation.service.ts` | `fee_plans`, `fee_plan_rules` (defer with 0 fees) | P2 |
| Merchant Limits Service | `src/modules/limits/merchant-limits.service.ts` | `merchant_limits`, `kyc_level_limits` | **P1** |
| Gateway Collection Method | `src/integrations/gateway/gateway-operations.client.ts` | Gateway API | **P1** |

### 8.2 Handlers to Complete

| Handler | File | Method to Call | Priority |
|---------|------|----------------|----------|
| Collection Pending | `collection.handlers.ts:19` | `PaymentLifecycleService.apply()` with verify | **P1** |
| Collection Unknown | `collection.handlers.ts:30` | `PaymentLifecycleService.apply()` with `outcome_unknown` | **P1** |
| Collection Successful | `collection.handlers.ts:41` | `PaymentLifecycleService.apply()` with `succeeded` | **P1** |
| Collection Failed | `collection.handlers.ts:52` | `PaymentLifecycleService.apply()` with `failed` | **P1** |
| Collection Expired | `collection.handlers.ts:63` | `PaymentLifecycleService.apply()` with `expired` | **P1** |
| Collection Cancelled | `collection.handlers.ts:70` | `PaymentLifecycleService.apply()` with `cancelled` | **P1** |

### 8.3 Integration Points to Add

| Location | Change Needed | Priority |
|----------|---------------|----------|
| `PaymentsService.create()` | Add gateway submission after commit | **P1** |
| `PaymentsService.cancel()` | Add gateway cancellation call (or mark local-only) | P2 |
| `PaymentExpiryService` | Add gateway expiry notification (if needed) | P2 |

---

## 9. Dependencies on Other Phase 4 Tasks

### 9.1 Blockers for P4-08/P4-09

**Must be complete first**:
- ✅ P4-01: Payouts/refunds tables (DONE — migration exists)
- **P4-02**: Routing service (blocks payment submission)
- **P4-03**: Fee engine (can defer with 0 fees)
- **P4-04**: Merchant limits (blocks payment creation)

**Can be parallel**:
- P4-13: Complete handlers (after gateway method exists)
- P4-08: Verify idempotency (already exists, just verify)
- P4-09: Verify outbox (already exists, just verify)

### 9.2 Blocks These Phase 4 Tasks

**P4-08 and P4-09 completion enables**:
- P4-05: Refunds (depends on collection posting working)
- P4-06: Payouts (uses same routing + gateway pattern)
- P4-10: Gateway chase job (needs completed handlers)
- P4-11: Payment expiry sweep (needs gateway integration)

---

## 10. Recommended Implementation Order

### Phase 1: Gateway Foundation (P4-08 Part 1)

**Goal**: Enable collection submission

1. **Add `submitCollection` to gateway client** (4 hours)
   - Port interface: `CollectionRequest`, `CollectionResult`
   - Client implementation: `POST /api/v1/payment/:providerId/collection`
   - Retry/circuit breaker logic (copy from `submitDisbursement`)
   - Tests: mock gateway responses

2. **Build routing service** (6 hours)
   - Repository: query `routing_rules` with filters
   - Service: `selectRoute()` algorithm
   - Circuit breaker integration
   - Provider status checks
   - Tests: various rule combinations

3. **Build merchant limits service** (3 hours)
   - Check per-transaction limit
   - Check daily/monthly aggregates
   - Tests: over-limit scenarios

4. **Wire payment creation to gateway** (4 hours)
   - Call routing service in `PaymentsService.create()`
   - Call limits service
   - Submit to gateway after commit
   - Handle gateway results (accepted/rejected/ambiguous)
   - Update payment status based on result
   - Tests: end-to-end payment flow

**Exit criteria**: Can create payment → submit to gateway → receive `processing` status

### Phase 2: Event Handling (P4-09 Part 1)

**Goal**: Complete collection lifecycle

5. **Complete collection handlers** (6 hours)
   - Map gateway event → `PaymentEventInput`
   - Call `PaymentLifecycleService.apply()` for each status
   - Tests: each handler with success/duplicate/rejected scenarios

6. **Integration tests** (4 hours)
   - Mock gateway: submit collection → receive events → payment succeeds
   - Verify ledger entry created
   - Verify merchant balance updated
   - Verify idempotency (duplicate events)
   - Verify rejection handling

**Exit criteria**: Payment runs end-to-end through gateway to `succeeded` with ledger posting

### Phase 3: Supporting Features

7. **Fee engine** (defer or build simple version) (4 hours)
   - Start with 0 fees, or
   - Build basic percentage + fixed fee calculation

8. **Verify idempotency interceptor** (2 hours)
   - Check against spec 8.2 requirements
   - Add to all money-moving routes
   - Concurrency tests

9. **Verify outbox** (2 hours)
   - Check against spec requirements
   - Add hold events if missing

**Total estimated effort**: ~35 hours for P4-08 and P4-09 core completion

---

## 11. Files Requiring Modification

### To Create

```
src/modules/routing/routing.service.ts
src/modules/routing/routing.repository.ts
src/modules/routing/routing.module.ts
src/modules/fees/fee-calculation.service.ts              [optional, can defer]
src/modules/fees/fees.repository.ts                      [optional]
src/modules/fees/fees.module.ts                          [optional]
src/modules/limits/merchant-limits.service.ts            [check if exists in Phase 7]
src/db/migrations/0014_fee_plans.sql                     [optional, can defer]
```

### To Modify

```
src/integrations/gateway/gateway-operations.port.ts      [add CollectionRequest/Result]
src/integrations/gateway/gateway-operations.client.ts    [add submitCollection()]
src/modules/payments/payments.service.ts                 [add gateway submission]
src/modules/payments/payments.module.ts                  [add routing, limits deps]
src/consumers/gateway-events/handlers/collection.handlers.ts  [implement 6 handlers]
src/common/errors/catalogue.ts                           [add error codes]
src/config/env.schema.ts                                 [add config vars if needed]
.env.example                                             [add config vars]
```

### To Verify

```
src/common/idempotency/idempotency.interceptor.ts        [verify against spec 8.2]
src/common/outbox/outbox.service.ts                      [verify against spec]
src/common/outbox/outbox.processor.ts                    [verify against spec]
```

---

## 12. Decision Points

### D1: Immediate vs Deferred Submission

**Question**: Should payment creation immediately submit to gateway, or stay in `created` until explicit submission?

**Current state**: Code comments suggest deferred was intended, but no submission mechanism exists.

**Recommendation**: Start with **immediate submission** for simplicity. Can add deferred option later.

### D2: Fee Engine Priority

**Question**: Build fee engine now or defer with 0 fees?

**Recommendation**: **Defer with 0 fees**. Start with `feeMinor = 0n` everywhere. Add fee engine after core money flow works.

### D3: Routing Rule Priority

**Question**: Should pinned provider (from `payment_method.provider`) override routing rules?

**Current spec** (P4-D5): YES, honor pinned provider if enabled.

**Recommendation**: Implement pinned provider check first in routing service.

### D4: Merchant Limits Enforcement Location

**Question**: Check limits in creation or in routing?

**Recommendation**: Check in `PaymentsService.create()` **before** routing. Fail fast if over limit.

---

## 13. Testing Requirements

### Unit Tests

- ✅ `PaymentLifecycleService.apply()` (likely exists)
- ❌ Routing service: provider selection with various rules
- ❌ Limits service: daily/monthly aggregation
- ❌ Each collection handler: success/duplicate/rejected paths

### Integration Tests

- ❌ **Critical**: Payment end-to-end with mocked gateway
  1. Create payment
  2. Gateway accepts (202)
  3. Receive `collection.successful` event
  4. Payment → `succeeded`
  5. Ledger entry created
  6. Merchant balance updated
- ❌ Idempotency: same key returns same response
- ❌ Concurrency: parallel payment creation with same key
- ❌ Routing: fallback when primary provider unavailable
- ❌ Limits: reject payment over daily limit

### Gateway Integration Tests

- ❌ Submit collection to real gateway (staging environment)
- ❌ Handle 429 rate limiting
- ❌ Handle 504 timeout (ambiguous outcome)
- ❌ Duplicate submission returns same result

---

## 14. Open Questions

1. **Does `PaymentExpiryService.sweep()` exist?**
   - Check if built in Phase 2 or ahead of schedule
   - Needs integration: expired payments should notify gateway (or not?)

2. **Does merchant limits service exist in Phase 7?**
   - Check `src/modules/compliance` or `src/modules/limits`
   - Phase 7 created tables but may not have enforcement logic

3. **What payment metadata is sent to gateway?**
   - Core transaction ID?
   - Merchant ID?
   - Environment (test/live)?

4. **How are test environment payments handled?**
   - Sandbox simulator exists (Phase 5)
   - Should test payments go to gateway or stay in sandbox?

5. **Is there a maximum payment amount before approval is required?**
   - Similar to payouts requiring approval over threshold

---

## 15. Spec References

- **3.4**: Gateway idempotency (fixed external ID)
- **3.5**: Ambiguous outcomes (504, timeout, 5xx)
- **5.5**: Collection ledger posting (P, M, F, N structure)
- **6.1**: Payment creation and lifecycle
- **6.11**: Merchant events (`payment.{status}`, `balance.updated`)
- **6.13**: AML pre-check before payment creation
- **8.2**: Idempotency interceptor requirements
- **P4-D5**: Honor pinned provider from `payment_method.provider`
- **P4-D6**: Provider fee = 0 until gateway provides it

---

## Conclusion

**Payment and lifecycle infrastructure is production-ready**, but the **gateway integration is entirely missing**. The core work for P4-08 and P4-09 is:

1. Add `submitCollection()` to gateway client
2. Build routing service for provider selection
3. Build or verify merchant limits enforcement
4. Wire payment creation → gateway submission
5. Complete 6 collection event handlers
6. End-to-end testing

**Estimated effort**: 35 hours of focused development

**No collections module exists** — all collection logic lives in the payments module. This is architecturally sound: collections are payments, not a separate domain.

The good news: `PaymentLifecycleService` is complete and well-designed. Once gateway calls are wired up, the state machine, ledger posting, and event handling will work correctly.

**Recommended first step**: Implement `submitCollection()` in the gateway client, then build the routing service. These two components unlock the rest of Phase 4.
