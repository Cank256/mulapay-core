# Phase 4: Money Movement - Detailed Breakdown

Status: Starting Phase 4 after completing Phase 3 (gateway integration)

## What Already Exists (Built in Phases 0-2, 5-8)

### ✅ Database Tables & Schema
- **Transactions** (`transactions`, `transaction_events`, `transaction_keys`) - Migration 0003
- **Payments** (`payments`, `payment_links`, `checkout_sessions`) - Migration 0003
- **Holds** (`holds`) - Migration 0004
- **Routing** (`routing_rules`, `provider_status`) - Migration 0008
- **Merchant limits** (`merchant_limits`) - Migration 0007 (KYC)
- **KYC level limits** (`kyc_level_limits`) - Migration 0007
- **Approvals** (`approvals`, `approval_decisions`) - Migration 0008
- **Outbox** (`outbox`) - Migration 0005
- **Idempotency** (`idempotency_keys`) - Migration 0005
- **Gateway events/requests** (`gateway_events`, `gateway_requests`) - Migration 0012 (Phase 3)
- **Consumer cursor** (`consumer_cursors`) - Migration 0008

### ✅ Services & Infrastructure
- **Ledger core** (`PostingService`, `ReversalService`) - Phase 2
- **Holds** (`HoldsService`) - Phase 2
- **Balances** (`BalancesService`) - Phase 2
- **Payment lifecycle** (`PaymentLifecycleService.apply`) - Built ahead of Phase 3/4
- **Payment creator** (`PaymentCreator`) - Built ahead
- **Payment expiry** (`PaymentExpiryService.sweep`) - Built ahead
- **Idempotency interceptor** - Phase 5 (needs verification against spec 8.2)
- **Outbox** (write side, dispatcher, handlers) - Phase 5 (needs full requirement check)
- **API key auth & scopes** - Phase 5
- **Request signing** - Phase 5
- **Rate limiting** - Phase 5
- **Webhooks** - Phase 5
- **Sandbox simulator** (`SandboxService`) - Phase 5
- **Circuit breaker** (`RedisCircuitBreaker`) - Phase 3
- **Gateway client** (`GatewayOperationsClient`) - Phase 3
- **Gateway event consumer** (`GatewayEventConsumer`) - Phase 3
- **Approvals workflow** (`ApprovalsService`) - Phase 8
- **AML pre-check** (`PayoutControlService`, `AmlScreeningService`) - Phase 7
- **Audit** (`AuditService`) - Phase 1
- **Metrics & monitoring** (`OpsMonitorService`) - Phase 8

### ✅ Supporting Modules Complete
- Identity & merchants (Phase 1)
- Authorization (CASL, Phase 1)
- Developer platform basics (Phase 5)
- Settlement & reconciliation (Phase 6)
- Compliance (KYC, AML, disputes) (Phase 7)
- Operations (incidents, complaints, reports) (Phase 8)

## What Needs to Be Built (Phase 4)

### 🔨 P4-01: Extend Transactions for Payouts & Refunds
**Status**: Payments-only today; need payout/refund support

**What exists**:
- `transactions` table with `type` column (already includes 'payout', 'refund', 'fee', etc.)
- `transaction_events` for event timeline
- Status transitions and guards (payment-only in migration 0003)
- TransactionsService with type filter

**What to build**:
1. Create `payouts` table (like `payments` but for disbursements)
   - Columns: id, ref, transaction_id, merchant_id, amount_minor, currency, destination, status
   - Status: created → processing → succeeded/failed/cancelled
   - Destination validation & encryption
2. Create `refunds` table
   - Columns: id, ref, transaction_id, merchant_id, payment_id, amount_minor, currency, status
   - Link to parent payment
   - Partial refund support (amount <= payment amount)
3. Extend transaction status checks to payouts & refunds
4. Extend transition guards (triggers) to payouts & refunds
5. Add metadata & idempotency link relationships

**Migration needed**: Yes (0013_payouts_refunds.sql)

---

### 🔨 P4-02: Routing & Collections
**Status**: Routing tables exist; routing service and collection initiation need building

**What exists**:
- `routing_rules` table (provider, priority, weight, active)
- `provider_status` table (health tracking)
- `RedisCircuitBreaker` (Phase 3)
- `GatewayOperationsClient.submitDisbursement()` (Phase 3)
- `PaymentCreator` (creates payment record)
- Sandbox simulator for test env

**What to build**:
1. **RoutingService**
   - `selectRoute(merchantId, operationType, amount, currency)` 
   - Priority-based selection (0-10000)
   - Weighted random within same priority
   - Check provider health (`provider_status`)
   - Check circuit breaker (`RedisCircuitBreaker.allow()`)
   - Honor pinned provider from `payment_method.provider` (P4-D5)
   - Return `no_route_available` if all providers unavailable
2. **Payment initiation flow**
   - Validate payment method (provider supports currency, MSISDN format)
   - Call routing service to select provider
   - Create transaction & payment (already exists)
   - Check merchant limits (P4-04 or here)
   - Call gateway AFTER transaction commit (not inside UnitOfWork)
   - Handle every gateway result: accepted, rejected, ambiguous, rate_limited
   - Record in `gateway_requests` (already done by recorder)
3. **Collection gateway call** (`GatewayOperationsClient` needs `submitCollection` method)
   - Similar to `submitDisbursement` but for collections
   - POST /api/v1/payment/{provider}/collection
4. **Metrics**: `core_payment_initiations_total`

**New services**: `RoutingService`, extend `PaymentsService` for gateway calls

**Migration needed**: No (tables exist)

---

### 🔨 P4-03: Fee Engine
**Status**: Not started; `merchants.fee_plan_id` column exists but tables don't

**What exists**:
- `merchants.fee_plan_id` (FK not enforced yet)
- Fee lines in ledger postings (P, F, N structure exists)

**What to build**:
1. `fee_plans` table
   - Columns: id, ref, name, merchant_id (null for platform plans), active
2. `fee_plan_rules` table  
   - Columns: id, fee_plan_id, operation_type, currency, rule_type, value_bps, fixed_minor, min_minor, max_minor, tier_thresholds
   - Rule types: fixed, percentage, minimum, maximum, tiered
3. **FeeCalculationService**
   - `calculateFee(operation, amount, currency, merchantId)` → bigint feeMinor
   - Exact bigint arithmetic (no floating point)
   - Load fee plan for merchant (or default platform plan)
   - Apply rules: percentage (bps), fixed, min, max, tiers
4. **Fee idempotency**: fees recalculated identically on retry
5. **Fee postings**: already structured in ledger, service supplies feeMinor

**Decision P4-D6**: Provider fee `P` = 0 until gateway provides it

**Migration needed**: Yes (0014_fee_plans.sql or add to 0013)

**Note**: Can start with 0 fees and defer full engine

---

### 🔨 P4-04: Merchant Limits Enforcement
**Status**: Tables exist (Phase 7 created them); enforcement logic needs building

**What exists**:
- `merchant_limits` table (Phase 7, from KYC)
  - per_transaction_minor, daily_minor, monthly_minor
  - payout_daily_minor, payout_monthly_minor
- `kyc_level_limits` table (default limits per KYC level)
- Phase 7 stores limits but doesn't enforce payout limits

**What to build**:
1. **MerchantLimitsService.checkTransaction()**
   - Check per_transaction_minor (one payment/payout)
   - Check daily_minor against sum of today's transactions
   - Check monthly_minor against sum of this month's transactions
   - Use merchant_limits OR kyc_level_limits (fallback)
2. **MerchantLimitsService.checkPayout()**
   - Check payout_daily_minor
   - Check payout_monthly_minor
   - Query sum from transactions where type='payout' and status='succeeded'
3. **Integration points**:
   - Call before payment creation (P4-02)
   - Call before payout creation (P4-06)
   - Return AppError('LIMIT_EXCEEDED') with details

**Migration needed**: No (tables exist)

**Note**: Check if Phase 7 already has partial implementation

---

### 🔨 P4-05: Refunds
**Status**: Not started; depends on payments and refunds table

**What exists**:
- Payments (succeeded payments can be refunded)
- Ledger postings (reversal patterns exist)
- `ReversalService` (for ledger corrections)
- Approvals workflow (Phase 8)
- Payout controls (`assertPayoutsAllowed`, `isSuspended` from Phase 7)

**What to build**:
1. `refunds` table (see P4-01)
2. **RefundsService**
   - `create(paymentId, amountMinor, reason, idempotencyKey)`
   - Full or partial refund
   - Only against `succeeded` payments
   - Row lock payment + check: `sum(refunds.amount) + new_amount <= payment.amount`
   - Check `refund_not_supported` for MTN (before gateway call)
   - Approval required if amount > `REFUND_APPROVAL_THRESHOLD_MINOR` (config)
   - Create transaction & refund records
3. **Refund state machine**:
   - created → processing → succeeded/failed/cancelled
   - Similar to payment lifecycle
4. **Ledger posting** (spec 5.5):
   - DR merchant_payable (reduce merchant balance)
   - CR customer_funds (money back to customer)
   - Fee handling (refund includes fee refund?)
5. **Gateway integration**:
   - Call gateway AFTER commit
   - Handle succeeded/failed/ambiguous
6. **Idempotency**: standard idempotency key
7. **Payout controls**: Call `assertPayoutsAllowed()` and `isSuspended()` (Phase 7)

**Refund handlers** (6 of 18 in P3-09): Complete in P4-13

**Migration needed**: Yes (refunds table in 0013)

---

### 🔨 P4-06: Disbursements (Payouts)
**Status**: Not started; most complex money movement

**What exists**:
- Holds system (Phase 2)
- Settlement payouts (Phase 6 uses gateway client)
- Gateway client `submitDisbursement()` (Phase 3)
- Approvals workflow (Phase 8)
- Payout controls (Phase 7)
- Encryption utilities (Phase 1)

**What to build**:
1. `payouts` table (see P4-01)
   - Destination encrypted (bank account, mobile money number)
2. **PayoutsService.create()**
   - Validate destination
   - Encrypt sensitive fields
   - Check available balance (`BalancesService`)
   - Create hold BEFORE gateway call (covers amount + fee)
   - Check approval rules:
     - Amount over merchant limit
     - Amount over threshold
     - New destination (first time)
   - Request approval if needed (Phase 8 `ApprovalsService`)
   - MFA re-auth within 5 minutes for approvers
3. **PayoutsService.submit()** (after approval if needed)
   - Create transaction & payout records
   - Call gateway AFTER commit
   - Handle gateway responses:
     - Accepted: payout → processing
     - Rejected: release hold, payout → failed
     - Ambiguous: keep hold, payout → processing + outcome_unknown flag
     - Rate limited: retry later
4. **Payout outcome handling** (via handlers P4-13):
   - Succeeded: capture hold, post ledger entry (DR merchant_payable, CR settlement)
   - Failed: release hold, no posting
   - Ambiguous: NO release, stays processing until chase job resolves
5. **Reversal handling**: If payout needs reversal, post compensating entry
6. **Payout controls**: Call Phase 7 services before allow

**Disbursement handlers** (6 of 18 in P3-09): Complete in P4-13

**Migration needed**: Yes (payouts table in 0013)

---

### 🔨 P4-07: Payout Batches
**Status**: Not started; depends on P4-06

**What to build**:
1. **PayoutBatchesService.create()**
   - Accept up to 10,000 payout items
   - Validate each item
   - Create batch record
2. **PayoutBatchesService.submit()**
   - Process each payout independently
   - Per-item failure isolation (one fails, others continue)
   - Idempotent (deterministic results per batch)
   - Track batch-level status
3. Batch approval flow (if any item needs approval)

**Migration needed**: Maybe (batch tracking table)

**Note**: Build after single payouts work (P4-06)

---

### 🔨 P4-08: Idempotency Interceptor Verification
**Status**: Built in Phase 5; needs verification against spec 8.2

**What exists**:
- Idempotency interceptor (Phase 5)
- `idempotency_keys` table

**What to verify**:
1. ✓ Redis `SET NX` fast path
2. ✓ Database row as durable truth
3. ✓ `409 CONFLICT` for changed request body
4. ✓ `409 REQUEST_IN_PROGRESS` with `Retry-After: 2` header
5. ✓ 24-hour replay window
6. Applied to: payments, refunds, payouts, batches (all money-moving routes)
7. Concurrency tests (see P4-T2)

**Tasks**:
- Review existing implementation
- Add to all new money routes (refunds, payouts)
- Add concurrency tests

---

### 🔨 P4-09: Outbox Verification
**Status**: Built minimally in Phase 5; needs full requirement check

**What exists**:
- Outbox table, dispatcher, three handlers (Phase 5)

**What to verify** (spec requirements):
1. ✓ Written in same transaction as state change
2. ✓ Claim with `FOR UPDATE SKIP LOCKED`
3. ✓ 60-second claim expiry
4. ✓ Exponential backoff
5. ✓ Alert on exhausted attempts
6. ✓ Processor registered in `jobs.module.ts`
7. ✓ Safe duplicate processing
8. Hold events go through outbox:
   - `hold.created`
   - `hold.released`
   - `hold.captured`
   - Hold expiry

**Tasks**:
- Review against spec
- Add hold events to outbox
- Verify merchant events for payments/payouts/refunds

---

### 🔨 P4-10: Gateway Chase Job
**Status**: Not started; critical for ambiguous outcomes

**What to build**:
1. **GatewayChaseService.sweep()**
   - Select transactions where:
     - status = 'processing'
     - outcome_unknown = true OR processing for > N minutes
     - type in ('payment', 'payout', 'refund')
     - gateway_external_id is not null
   - Query gateway by external_id (`GatewayOperationsClient.findByExternalId`)
2. Handle gateway responses:
   - Found + successful: apply success event
   - Found + failed: apply failure event  
   - Found + still pending: log, check again later
   - Not found: depends on operation (payment might be rejected, payout might be unknown)
   - Gateway timeout/unavailable: retry later
3. **Deterministic job IDs**: same transaction queried only once per time period
4. **Stop on terminal**: don't query successful/failed transactions
5. **Metrics**: chase attempts, resolutions, unresolved count
6. **Feed reconciliation**: unresolved after max attempts → reconciliation exception
7. **Queue routing**: Add to `SandboxProcessor` as `gateway.chase` job (P3-13 ready)

**Schedule**: Every 5 minutes for processing transactions (P4-11)

**Migration needed**: No

---

### 🔨 P4-11: Scheduler Setup
**Status**: Consumer process exists; need to add scheduled jobs

**What exists**:
- Consumer process (`main.consumer.ts`)
- Advisory lock (already holds it)
- Some schedules in Phase 5-9

**What to schedule** (check which exist):
1. **Payment expiry sweep** (`PaymentExpiryService.sweep`)
   - Every minute or configurable interval
   - Expires created payments past timeout
2. **Hold expiry sweep** (`HoldsService.expireDue`)
   - Every minute (spec requirement)
   - Releases expired holds
3. **Outbox dispatch** (check if exists in Phase 5)
   - Every few seconds
   - Processes pending outbox events
4. **Gateway chase** (P4-10)
   - Every 5 minutes
   - Queries ambiguous transactions

**Check existing schedules**:
- Settlement cycles
- Reconciliation runs  
- AML scans
- Report generation
- Incident monitors

**Tasks**:
- Review which schedules exist
- Add missing schedules to consumer process
- Ensure no duplicate schedules

---

### 🔨 P4-12: Approvals Routes
**Status**: Approval workflow exists (Phase 8); routes need building

**What exists**:
- `approvals`, `approval_decisions` tables
- `ApprovalsService` (Phase 8)
- Maker-checker logic

**What to build**:
1. **Admin routes** (`/admin/v1/...`):
   - `POST /journal-entries/adjustment` (approval always required)
   - `POST /journal-entries/:ref/reverse` (approval always required)
   - `POST /holds` (create hold with approval)
   - `POST /holds/:ref/release` (with approval)
   - `POST /holds/:ref/capture` (with approval)
2. **Payout/refund approval routes**:
   - `POST /payouts/:ref/approve`
   - `POST /payouts/:ref/reject`
   - `POST /refunds/:ref/approve`
   - `POST /refunds/:ref/reject`
3. **Force-resolve route** (P4-D9):
   - `POST /payouts/:ref/force-resolve` (for stuck payouts)
   - Requires approval (who can approve? C-level?)
4. **State machine**: pending → approved/rejected/expired
5. **Idempotent decisions** (same approver clicking twice)
6. **Audit every action** (`AuditService.record`)

**Move from Phase 6**: Reconciliation resolution requests to shared approval workflow

**Migration needed**: No (tables exist)

---

### 🔨 P4-13: Complete Disbursement & Refund Handlers
**Status**: Stubs created in P3-09; need implementation

**What exists**:
- 18 handler stubs (3 types × 6 statuses)
- Collection handlers reference `PaymentLifecycleService.apply`
- `GatewayEventHandlerRegistry`

**What to build**:
1. **Disbursement handlers (6)**:
   - `pending`: verify payout exists, in processing state
   - `unknown`: mark outcome_unknown, keep hold
   - `successful`: capture hold, post ledger entry, transition to succeeded
   - `failed`: release hold, transition to failed
   - `expired`: release hold, transition to expired  
   - `cancelled`: release hold, transition to cancelled
   - Settlement payouts (`po_*`): call `SettlementOutcomeService.apply` (Phase 6)

2. **Refund handlers (6)**:
   - Similar to disbursement but for refunds
   - `successful`: post refund entry, transition to succeeded
   - Link to parent payment

3. **Collection handlers** (already have PaymentLifecycleService reference):
   - Wire to actual service (might already be done)
   - Ensure 6 status handlers complete

**Integration**: All handlers registered in `GatewayEventHandlerRegistry`

---

### 🔨 P4-14: Permissions, Scopes, Errors & Config
**Status**: Ongoing throughout Phase 4

**What to add**:
1. **Permissions** (staff & merchant):
   - `payments:create`, `payments:read`
   - `refunds:create`, `refunds:read`, `refunds:approve`
   - `payouts:create`, `payouts:read`, `payouts:approve`
   - `payouts:force_resolve` (for P4-D9)
2. **API Key scopes**:
   - `payments:write`, `payments:read`
   - `refunds:write`, `refunds:read`
   - `payouts:write`, `payouts:read`
3. **Error codes** (`src/common/errors/catalogue.ts`):
   - `PAYMENT_METHOD_INVALID`
   - `NO_ROUTE_AVAILABLE`
   - `REFUND_EXCEEDS_PAYMENT`
   - `REFUND_NOT_SUPPORTED`
   - `INSUFFICIENT_BALANCE`
   - `LIMIT_EXCEEDED`
   - `PAYOUT_DESTINATION_INVALID`
   - `HOLD_FAILED`
4. **Config variables** (`env.schema.ts` + `.env.example`):
   - `REFUND_APPROVAL_THRESHOLD_MINOR`
   - `PAYOUT_APPROVAL_THRESHOLD_MINOR`
   - `PAYMENT_EXPIRY_SECONDS`
   - `GATEWAY_CHASE_INTERVAL_MS`
5. **Test**: permissions.ts vs database seed

---

## Phase 4 Decisions Summary

### Must Decide Before Building:

**P4-D1**: Refunds take holds? (Default: YES, race-free)
**P4-D2**: AML pre-check for payouts? (Default: YES, call Phase 7 service)
**P4-D3**: Request signatures on payouts? (Default: live always signed)
**P4-D4**: Payment expiry from processing? (Default: only from created)
**P4-D5**: Honor pinned provider? (Default: YES, honor payment_method.provider)
**P4-D6**: Provider fee P? (Default: 0 until gateway provides it)
**P4-D7**: Payout/refund holds never expire? (Default: YES, null expires_at)
**P4-D8**: Reserved balance = 0? (Default: YES, settlement handles reserve)
**P4-D9**: Force-resolve approval? (Default: C-level with maker-checker)

---

## Recommended Build Order

### Sprint 1: Foundation (P4-01, P4-14 partial)
1. Migration 0013: payouts & refunds tables
2. Extend transaction guards to payouts/refunds
3. Basic permissions & error codes

### Sprint 2: Routing & Payments (P4-02, P4-04)
4. RoutingService (provider selection)
5. Merchant limits enforcement  
6. Payment initiation with gateway call
7. Collection gateway method

### Sprint 3: Handlers (P4-13 partial)
8. Complete collection handlers (wire to PaymentLifecycleService)
9. Test end-to-end payment flow

### Sprint 4: Refunds (P4-05, P4-13 partial)
10. RefundsService
11. Refund handlers
12. Refund routes with idempotency

### Sprint 5: Payouts (P4-06, P4-13 partial)
13. PayoutsService with holds
14. Payout handlers (disbursement + settlement)
15. Payout routes with approvals

### Sprint 6: Supporting Features
16. Fee engine (P4-03) - can start with 0 fees
17. Gateway chase job (P4-10)
18. Payout batches (P4-07)
19. Approval routes (P4-12)
20. Scheduler setup (P4-11)

### Sprint 7: Verification & Testing
21. Verify idempotency interceptor (P4-08)
22. Verify outbox (P4-09)
23. Concurrency tests (P4-T2)
24. End-to-end tests (P4-T3)
25. Documentation updates (P4-T6)

---

## Exit Criteria Checklist

✅ **P4-T3**: Payment runs end-to-end against mocked gateway → ledger  
✅ **P4-T2**: Concurrency suite passes (50 parallel requests, refund limits, hold captures)  
✅ Typecheck, lint, unit tests pass  
✅ Integration tests pass  
✅ Migrations apply cleanly  
✅ No unresolved architectural conflicts  
✅ All 9 decisions documented

---

## Estimated Effort

- **P4-01**: 2-3 hours (tables + guards)
- **P4-02**: 4-6 hours (routing + payment flow)
- **P4-03**: 3-4 hours (fee engine) or defer with 0 fees
- **P4-04**: 2-3 hours (limits enforcement)
- **P4-05**: 4-5 hours (refunds)
- **P4-06**: 6-8 hours (payouts most complex)
- **P4-07**: 2-3 hours (batches, after P4-06)
- **P4-08**: 1-2 hours (verification)
- **P4-09**: 1-2 hours (verification)
- **P4-10**: 3-4 hours (chase job)
- **P4-11**: 1-2 hours (scheduler)
- **P4-12**: 3-4 hours (approval routes)
- **P4-13**: 4-5 hours (handlers)
- **P4-14**: Ongoing (1-2 hours)
- **Tests**: 6-8 hours (P4-T1 through P4-T6)

**Total**: ~40-55 hours of focused development

This is a multi-day, multi-session effort requiring careful attention to financial correctness.
