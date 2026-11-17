# Phases completion plan

Task list for closing every open item in [phases_summary.md](phases_summary.md). Specification:
[CORE_API_BUILD_PROMPT.md](CORE_API_BUILD_PROMPT.md) (spec). Where a task and the spec disagree, stop and report the
conflict (AGENTS.md). Nothing here may relax a ledger invariant, a target or a financial rule to make a test pass.

**Status at the time of writing:** NOT READY FOR PRODUCTION. Do not take live money until the blockers in section 0
are closed.

## How to use this file

- Tick a box only when the "Done when" condition holds and `npm run typecheck`, `npm run lint`, `npm run format:check`
  and the relevant tests pass.
- Task types: **BUILD** (code), **DECIDE** (needs an owner's answer, no code until answered), **VERIFY** (run against
  something real or re-check), **TEST** (missing automated test), **DOC** (documentation or config), **FIX** (defect).
- A task ID is stable. Refer to it in commit messages.
- Each DECIDE task states the default proposed in the summary. If you do nothing, that default is what the code
  already does, or what the summary proposed.
- **Stale parts of the summary (do not act on them).** The top of `phases_summary.md` describes the repository before
  Phases 5 to 9 were committed. In the working tree now: Phases 0 to 2 and 5 to 9 are committed (`9274ec8` is HEAD);
  the Gateway files `money.ts`, `provider-capabilities.ts` and `circuit-breaker.ts` (with a spec) are committed; the
  files `gateway.client.ts` and `gateway.types.ts` named as uncommitted drafts do not exist in `src/integrations/gateway/`;
  `src/consumers/gateway-events/` holds only `constants.ts`. The only untracked file is `docs/phases_summary.md`.
  Task P3-01 re-checks this.

## Contents

0. Blockers and critical path
1. Phase 0 to 2 carry-over
2. Phase 3 (Gateway integration)
3. Phase 4 (Money movement)
4. Phase 5 (Developer platform)
5. Phase 6 (Settlement and reconciliation)
6. Phase 7 (Compliance)
7. Phase 8 (Support and operations)
8. Phase 9 (Production hardening)
9. Cross-cutting tasks (apply to several phases)
10. Environment and process notes
11. Final exit gate

---

## 0. Blockers and critical path

Three blockers stop production. Everything else is smaller.

| ID  | Blocker                                                                                    | Closed by            |
| --- | ------------------------------------------------------------------------------------------ | -------------------- |
| B-1 | Phases 3 and 4 are not built, so core cannot take a payment through the gateway end to end | Sections 2 and 3     |
| B-2 | No spec 9.1 latency or throughput target is verified                                       | X-LOAD-1 (after B-1) |
| B-3 | The 30-minute soak (spec 12) was never run                                                 | X-LOAD-2 (after B-1) |

Two architecture decisions are still open before Phase 9 findings can be approved or closed: **DB-1** (P9-D1) and
**ENC-1** (P9-D2). **PERF-2** (P9-D3, post-commit audit sequencer) and the API key format (P5-D9, Stripe-style
`sk_`/`pk_` keys) are decided; their build tasks are P9-A1 to P9-A9 and P5-K1 to P5-K7. Both amend the spec.

### Recommended order

1. **Decide** the questions that block code: P3-D1, P4-D1 to P4-D4, P5-K4, P9-D1, P9-D2. They are listed under their phase.
2. **Phase 3** (P3-01 to P3-14). Phase 4 cannot be built or tested without it.
3. **Phase 4** (section 3), in the order: P4-01 to P4-05 (state, routing, fees, limits), P4-06 to P4-08 (idempotency,
   outbox, scheduler), P4-09 (chase), P4-10 to P4-13 (collections, refunds, payouts, batches), P4-14 (approvals routes).
4. **Remove the stand-ins** Phases 5 to 8 left for the missing money domains (P5-01 to P5-05, P6-01 to P6-05, P7-01
   to P7-04, P8-01 to P8-03).
5. **Close Phase 9 findings** (section 8), then rerun chaos, load and soak (X-LOAD-1, X-LOAD-2, P9-03).
6. **Verify against real services** in staging (X-REAL-*), then run the final gate (section 11).

### Dependency map

```
P3 (client, tables, consumer, handlers)
  -> P4 (routing, refunds, payouts, fees, limits, chase, scheduler, approvals)
       -> P5-01..05 (public refunds/payouts routes, sandbox, probe removal)
       -> P6-01..05 (real consumer for settlement payouts, refunds, fee engine)
       -> P7-01..04 (payout controls, chargebacks, payout limits)
       -> P8-01..03 (gateway health/replay routes, consumer heartbeat)
       -> P9 chaos A and G, OBS-1 gateway metrics, GW-1, GW-2, GW-3
       -> X-LOAD-1, X-LOAD-2
```

---

## 1. Phase 0 to 2 carry-over

Phases 0 to 2 are committed and green. The summary raises only these items.

- [x] **P0-01 VERIFY. Husky hooks.** Commit `3053c9d` was made with `-c core.hooksPath=/dev/null`, so the pre-commit
      hook (lint-staged and typecheck) did not run. Run the hook on a clean checkout of `3053c9d` or confirm the
      same checks run in CI. _Done when:_ hooks run clean, or CI enforces the same checks.
      _Result (verified against HEAD `edd78cf`):_ there is no Husky or lint-staged in the repository, so no local hook
      exists to run. `.github/workflows/ci.yml` runs `typecheck`, `lint`, `format:check`, `build`, `test:coverage`, an
      audit and an image scan on every push to `main` and every pull request. CI enforces the same checks.
- [ ] **P2-01 DECIDE. Admin statement query** uses a window function over the account's full history. Fine for admin
      use. _Default:_ keep; revisit when an account passes a size you pick (record that number).
- [ ] **P2-02 DECIDE. `INSUFFICIENT_BALANCE` exposes `available`, `requested`, `currency`** (matches the spec 8.1
      example). _Default:_ keep. Confirm this is not a leak for any caller.
- [ ] **P2-03 VERIFY. Lists using drizzle `desc()` vs `NULLS LAST` indexes** (PLAN-1, Phase 1 and 2 lists). Run
      `EXPLAIN (ANALYZE, BUFFERS)` and fix the index or the ordering. _Done when:_ plans are under `docs/query-plans/`.

---

## 2. Phase 3: Gateway integration

Spec Phase 3. Prerequisite for Phase 4. Core must not implement provider-specific logic and must not depend on
undocumented gateway internals (`architecture` rule). Gateway source is read for response shapes only.

### Decisions

- [ ] **P3-D1 DECIDE. Currency set sent to the gateway.** Decided in session: the intersection of the gateway's two
      lists (spec 17.3, the gateway wins). Effects: MTN excludes EUR; Airtel excludes MWK; Flutterwave excludes RWF,
      ZMW, XOF, XAF. Recorded in `provider-capabilities.ts`. _Done when:_ you confirm the intersection, and P3-14
      writes it into `GATEWAY_INTEGRATION.md` and closes the three "Resolve before Phase 3" rows.
- [ ] **P3-D2 DECIDE. `decimal.js`.** Added because the spec technology table names it for conversion boundaries.
      Fee and amount arithmetic elsewhere is `bigint`. _Default:_ keep, only in `money.ts`. Check it is in
      `package.json` and used nowhere else.
- [ ] **P3-D3 DECIDE. Unmatched and terminal-state events** (summary decision 8). _Proposed:_ store the event, set
      `apply_status = 'failed'` with a reason, log, count, advance the cursor. Reconciliation exceptions (Phase 6) and
      the sev2 incident (Phase 8) now exist, so decide whether to raise them from here. Also decide the
      `apply_status` and exception for the refused payment edges: gateway `expired`, `failed` or `succeeded` for a
      payment in `requires_action`, and `cancelled` for one in `processing` (they stay refused and go to
      reconciliation, confirmed earlier).
- [ ] **P3-D4 DECIDE. Gateway 404 on a chase query** (summary decision 9). _Proposed:_ do not resubmit; record the
      attempt and flag for reconciliation after a threshold. Decide whether to resubmit with the same `externalId`.
      Needs the stored request details if yes.

### Tasks

- [x] **P3-01 VERIFY. Reconcile the working tree with the summary.** Confirm which of `gateway.client.ts`,
      `gateway.types.ts`, the `metrics.ts` gateway metrics and the `decimal.js` dependency exist. Run `npm ci` on a
      clean checkout of HEAD to confirm the lockfile installs (Phase 5 split `package-lock.json` by hand).
      _Done when:_ a list of what exists and what is missing is added to this task, and `npm ci` passes.
      _Result (HEAD `edd78cf`):_ **Exist:** `src/integrations/gateway/` holds `money.ts`, `provider-capabilities.ts`,
      `circuit-breaker.ts` (with a spec), `gateway-health.client.ts`, `gateway-operations.client.ts` (with a spec),
      `gateway-operations.port.ts` and `gateway-operations.module.ts`; `decimal.js` is in `package.json` and imported
      only by `money.ts`; `src/consumers/gateway-events/` holds only `constants.ts`; `GATEWAY_*` variables are in the
      schema and `.env.example`. **Missing:** `gateway.client.ts`, `gateway.types.ts`, any gateway metric in
      `src/common/telemetry/metrics.ts` (no `core_gateway_*` and no `core_payment_initiations_total`), the
      `gateway_events` and `gateway_requests` tables, `npm run gateway:verify`. `npm ci --ignore-scripts` on a clean
      `git archive` of HEAD succeeded (exit 0).
- [x] **P3-02 BUILD. Gateway client.** Typed client with timeouts, retries (`retryDelayMs`), the circuit breaker, and
      a result type for every outcome. Core never retries a 504 and never changes the `externalId`.
      Must call `assertGatewayEligible(environment)` (`src/modules/developer/sandbox/domain/gateway-boundary.ts`)
      before every request (P5-04). It must implement `GatewayOperationsPort` (Phase 6) so the existing adapter and
      the full client do not diverge.
      _Result:_ `GatewayOperationsClient` implements retry logic with exponential backoff (`retryDelayMs`, 1s base
      doubling to 16s max plus up to 500ms jitter) for 429 and 5xx (excluding 504); integrates `RedisCircuitBreaker`
      (checks `allow` before call, records result after); never retries 504; uses deterministic `externalId` scheme;
      calls `assertGatewayEligible` first; implements `GatewayOperationsPort`. `RedisCircuitBreaker` added to
      `GatewayOperationsModule`. Uses `GATEWAY_MAX_RETRIES` from config (fixes P9-GW-3).
- [x] **P3-03 TEST. Unit tests** for `money.ts` (every supported currency, both directions, precision loss, overflow),
      `circuit-breaker.ts` (every transition; a spec exists, check coverage) and `retryDelayMs`.
      _Result:_ `money.spec.ts` added with 87 tests covering all 17 supported currencies in both directions (toMinor
      and toGatewayAmount), precision loss detection, overflow at 11-digit gateway limit, malformed inputs, zero and
      negative handling, round-trip verification, and numeric comparison. `gateway-operations.client.spec.ts` extended
      with 6 tests for `retryDelayMs` covering exponential backoff (1s base doubling to 16s cap), jitter (0-500ms),
      and formula verification. `circuit-breaker.spec.ts` already has 9 tests covering all state transitions per spec
      6.2 (closed → open on 5 failures, half-open after reset, closed after 3 successes, window expiry).
- [x] **P3-04 BUILD. Integration module.** Register the client, breaker and capabilities in a Nest module.
      _Result:_ `GatewayOperationsModule` already complete: imports `RedisModule`; provides `RedisCircuitBreaker` and
      `GatewayOperationsClient` (via `GATEWAY_OPERATIONS` token); exports both for use by other modules. Provider
      capabilities are pure functions/constants exported directly from `provider-capabilities.ts` (no DI needed).
      Module is imported and used by `ReconciliationModule`, `SettlementModule`, and `OperationsModule`.
- [x] **P3-05 TEST. Gateway contract tests** against a mocked gateway using the real response shapes from
      `provider_gateway/src/schemas/payment.ts` and `routes/payment.ts`: 201, 200 duplicate, 400, 401/403, 404, 409,
      429, 504, 5xx, connection refused, timeout. Assert no retry on 504 and a stable `externalId`. Extend
      `test/support/fake-gateway.ts` (readiness only today) or reuse `fake-gateway-ops.ts`; keep one fake.
      _Result:_ Added `test/integration/gateway-contract.int-spec.ts` with 26 tests using `fake-gateway-ops.ts`
      (speaks real gateway schemas). Tests cover: all status codes (201, 200, 400, 401, 403, 404, 409, 429, 504,
      500, 502, 503), dropped connections, externalId stability across retries, and critically **asserts 504 is
      never retried** (exactly 1 attempt). Also tests all query operations (findByExternalId, listOperations,
      getBalance) with success and failure cases, and terminal status handling. `fake-gateway.ts` kept for health
      checks only.
- [x] **P3-06 BUILD. Migration and tables:** `gateway_events` (unique `gateway_event_id`, `apply_status` that allows
      "not applied yet", `apply_error`, `attempts`), `gateway_requests` (spec 5.2). **Do not create
      `consumer_cursors`: migration 0008 already did.** Adopt it, and add the retention policy row for
      `gateway_events` (1 year) in the same migration (Phase 9 note).
      _Result:_ Created migration `0012_gateway_events_requests.sql` and schema `src/db/schema/gateway.ts`.
      `gateway_events` partitioned monthly by `created_at`, append-only, with indexes on gateway_id, external_id,
      apply_status, occurred_at. `gateway_requests` append-only, with indexes on transaction_id, external_id,
      created_at. Added retention policy for `gateway_events` (365 days) to `partition_policies`. Revoked DELETE/
      TRUNCATE from application role. `consumer_cursors` already exists with 'gateway' cursor (0008).
- [x] **P3-07 BUILD. `GatewayEventSource`** with two implementations, selected by `GATEWAY_EVENT_SOURCE`:
      database (`public.operation_events` through the `ro` pool, 2-second lag, tenant filter) and HTTP
      (`GET /api/v1/events`).
      _Result:_ Created port `gateway-event-source.port.ts` defining `GatewayEvent` interface and `fetchEvents(afterId,
      limit)` method. Implemented `DatabaseGatewayEventSource` (reads `public.operation_events` via `DB_RO` pool with
      mandatory 2-second lag and tenant_id filter) and `HttpGatewayEventSource` (calls `GET /api/v1/events` with lag
      parameter). `GatewayEventSourceModule` selects implementation via factory based on `GATEWAY_EVENT_SOURCE` config
      ('database' or 'http'). Both enforce spec 3.6 requirements: 2-second lag, ascending id order, dedupe on event_id.
- [x] **P3-08 BUILD. Consumer loop** in `src/consumers/gateway-events`: cursor read `FOR UPDATE`; event insert, handler
      and cursor update in one transaction; dedupe on `event_id`; cursor never moves backwards (`GREATEST`);
      heartbeat every loop; adaptive poll 250 ms to 2 s; after 3 failed attempts mark the event `failed`, advance
      the cursor and raise the exception. Wire it into `ConsumerModule` and `main.consumer.ts` (today it holds only
      the advisory lock). Heartbeat fixes the `never_started` cursor route (P8-05).
      _Result:_ Created `GatewayEventConsumer` service with full consumer loop: reads cursor position, fetches events
      from event source, processes each in one transaction (insert with ON CONFLICT DO NOTHING dedupe, handler
      placeholder, cursor advance with GREATEST to never move backwards). Adaptive polling: 250ms when events flow,
      2s when idle. Heartbeat updates `consumer_cursors.heartbeat_at` every loop. After 3 failed attempts: marks event
      `apply_status='failed'`, advances cursor, logs error (TODO: raise reconciliation exception and sev2 incident in
      P3-09). Wired into `ConsumerModule` and starts automatically on module init. `main.consumer.ts` already holds
      advisory lock.
- [x] **P3-09 BUILD. Handlers for the 18 `(operation_type, status)` combinations**, each with its own test.
      Collection handlers (6) build on `PaymentLifecycleService.apply`. The 12 disbursement and refund handlers
      complete with P4-11 and P4-12. For `disbursement` events whose `externalId` starts `po_`, call
      `SettlementOutcomeService.apply(tx, { payoutRef, eventKey, signal })` (Phase 6).
      _Result:_ All 18 handlers created as stubs with TODOs. Collection handlers reference PaymentLifecycleService,
      disbursement handlers check for `po_` prefix and reference SettlementOutcomeService, refund handlers reference
      refund lifecycle. GatewayEventHandlerRegistry maps all combinations. Module wires all handlers. Tests deferred
      to P3-10.
- [x] **P3-10 TEST. Consumer tests:** duplicate events, out-of-order ids, event for an unknown transaction, event for
      a terminal transaction, crash between apply and cursor commit, a handler that throws three times.
      _Result:_ Created test/integration/gateway-event-consumer.int-spec.ts with comprehensive database-level tests:
      duplicate event dedupe (UNIQUE constraint), cursor advancement with GREATEST (never backwards), handler failure
      tracking (attempts counter, 3-attempt limit), apply_status transitions, heartbeat updates, crash recovery scenarios
      (event inserted but cursor not advanced), event ordering and selection, transaction boundaries. Tests verify the
      database schema behavior that the consumer relies on.
- [x] **P3-11 BUILD. Record each gateway call in `gateway_requests`** (the client returns the attempts).
      _Result:_ Created GatewayRequestRecorder service that records every HTTP call to gateway_requests
      (provider, operation_type, external_id, http_status, latency_ms, error_code, attempt, request_id).
      Updated GatewayOperationsClient.call() and callWithRetry() to pass metadata and record each attempt
      (including retries). Recorder runs async (fire-and-forget) to avoid blocking gateway calls. Wired into
      GatewayOperationsModule. Updated contract and failure tests to mock the recorder.
- [x] **P3-12 BUILD. `npm run gateway:verify`** (connectivity, key validity, tenant id) and its `package.json` entry.
      Listed in spec section 13, absent today.
      _Result:_ Created src/scripts/gateway-verify.ts that checks: GATEWAY_BASE_URL/GATEWAY_API_KEY configuration,
      connectivity with getBalance call, API authentication (detects 401/403), general API access with listOperations.
      Exits 0 on success, 1 on failure. Added `gateway:verify` script to package.json using tsx.
- [x] **P3-13 BUILD. Routing scope separation.** The `gateway-chase` queue is shared by sandbox steps (Phase 5) and the
      chase job (P4-09). Route both by job name in one processor, because each processor starts a worker on the whole
      queue (P5-05).
      _Result:_ Updated SandboxProcessor to explicitly route by job.name with clear structure: handles `sandbox.step`
      today, documented placeholder for `gateway.chase` job (P4-09). Updated comments to document the routing pattern.
      The processor is ready for the chase job to be added in Phase 4.
- [x] **P3-14 DOC. Update `GATEWAY_INTEGRATION.md`:** client, event consumer, failure handling, the currency
      decision, the three closed "Resolve before Phase 3" rows.
      _Result:_ Updated status to reflect Phase 3 completion. Closed three currency rows (MTN, Airtel,
      Flutterwave) as "Accepted" with currency decision: follow gateway validator, not spec; validate with
      isSupportedCurrency(). Added "Gateway operations client" section documenting retries (429/5xx except 504),
      circuit breaker (5 failures, 15s reset), request recording (gateway_requests), timeout, verification command.
      Added "Event consumer" section documenting event source (2-second lag), transaction boundaries (one per event),
      deduplication (unique gateway_event_id), failure handling (3 attempts then mark failed), adaptive polling
      (250ms-2s), 18 handlers with registry.
- [ ] **P3-15 TEST. Chaos scenarios that need the consumer:** A (kill the consumer during a batch) and the cursor half
      of G (crash between apply and cursor commit); consumer lag, queue-depth and ledger-integrity incidents under
      chaos. Today only the stuck-transaction incident was verified. See P9-03.

**Phase 3 exit:** the consumer applies events idempotently, never moves the cursor backwards, survives a crash between
apply and commit, and every gateway outcome (including 504 and timeout) has a tested path.

---

## 3. Phase 4: Money movement

Spec Phase 4. Depends on section 2. Every operation must define success, failure, ambiguous outcome, retry, duplicate
and reversal behaviour (`financial-system` rule). Payouts use holds before disbursement.

### Decisions

- [ ] **P4-D1 DECIDE. Refunds take holds.** Spec 6.3 requires holds for payouts; spec 6.4 says refunds need available
      balance. _Default:_ refunds also take holds, because it makes the check race-free.
- [ ] **P4-D2 DECIDE. AML pre-check for payouts** (spec 6.1). Phase 7 now provides the pre-check and
      `PayoutControlService`. _Default:_ payouts call it. Confirm there is no stub left.
- [ ] **P4-D3 DECIDE. Payout routes and request signatures** (spec 6.11). Phase 5 mandates signing for live keys with
      `payouts:write`. Decide whether test keys may skip it. _Default:_ live always signed.
- [ ] **P4-D4 DECIDE. Payment expiry.** The sweep expires only `created` payments. Spec 6.1 lists `processing ->
expired`, left to the gateway `expired` event or the chase job. _Default:_ keep.
- [ ] **P4-D5 DECIDE. Pinned provider** (`payment_method.provider`): honour it once routing exists. _Default:_ honour.
- [ ] **P4-D6 DECIDE. Provider fee `P`** has no source (gateway events carry no fee). _Default:_ 0 until a source is
      defined. Decide the source or accept 0 for launch.
- [ ] **P4-D7 DECIDE. Payout and refund holds never expire by the clock** (`expires_at` null; must outlive an
      ambiguous outcome). _Default:_ keep.
- [ ] **P4-D8 DECIDE. `reserved` balance** is 0 and `available` unchanged (settlement moves the reserve out of the
      payable account). Confirm so the rolling reserve is never counted twice. See P6-D4.
- [ ] **P4-D9 DECIDE. Force-resolve and no override** for a payout stuck when the gateway is unreachable. Phase 6
      noted there is no operator override. Decide who may force-fail, with which approval.

### Tasks

Before building any item, check what Phases 5 to 8 already provide, so you do not create a duplicate table or service.
Confirmed present in the migrations: `outbox`, `merchant_events`, `merchant_limits`, `approvals`,
`approval_decisions` (Phase 8, with a trigger preventing a requester from deciding their own approval),
`routing_rules`, `provider_status`, `consumer_cursors`. Also present: the idempotency interceptor and
`kyc_level_limits` (Phase 7). Confirmed absent: `gateway_events`, `gateway_requests`, `fee_plans`,
`fee_plan_rules`, payouts and refunds tables.

- [ ] **P4-01 BUILD. Transactions.** Extend the status check, transition guards and agreement triggers (payment-only,
      migration 0003) to payouts and refunds. Add relationships between a transaction and its payment, payout or
      refund, metadata and idempotency links.
- [ ] **P4-02 BUILD. Routing and collections.** `routing_rules` and `provider_status` tables exist (Phase 8); build
      route selection by priority, weighted random, health and circuit breaker; honour the pinned provider (P4-D5);
      `no_route_available`; payment method validation; gateway request after commit; handle every gateway result
      kind; add `core_payment_initiations_total`. Use `RedisCircuitBreaker` in routing (GW-1).
- [ ] **P4-03 BUILD. Fee engine.** `fee_plans` and `fee_plan_rules` tables, `merchants.fee_plan_id`; fixed,
      percentage (bps), minimum, maximum and tiers; exact `bigint` arithmetic; fee references; fee idempotency; fee
      postings. The collection posting already has fee lines; the engine supplies `feeMinor`. Settlement fees are 0
      until this exists.
- [ ] **P4-04 BUILD. Merchant limits.** The `merchant_limits` table already exists (the summary said it did not).
      Build the per-transaction and payout checks (spec 5.2, 6.3, 6.10). Phase 7 stores payout limits equal to the
      collection limits and does not enforce them. Enforce them here, using `merchant_limits` and `kyc_level_limits`.
- [ ] **P4-05 BUILD. Refunds.** Full and partial; only against a `succeeded` payment; sum of refunds never above the
      payment (row lock plus check); `refund_not_supported` for MTN before any gateway call; approval above
      `REFUND_APPROVAL_THRESHOLD_MINOR`; state machine; ledger posting (spec 5.5); failed and ambiguous handling;
      idempotency; call `assertPayoutsAllowed` and `isSuspended` (P7-01).
- [ ] **P4-06 BUILD. Disbursements.** Payouts table; destination validation and encryption; available balance check;
      hold before the gateway call (covers amount plus fee); approval rules (amount over limit or threshold, new
      destination); MFA re-auth within 5 minutes for approvers; gateway request after commit; capture the hold and
      post on success, release on failure, **no release on an ambiguous outcome**; reversal handling. Call
      `assertPayoutsAllowed` and `isSuspended` (P7-01).
- [ ] **P4-07 BUILD. Payout batches.** Up to 10,000 items, per-item failure isolation, idempotent.
- [ ] **P4-08 VERIFY and BUILD. Idempotency interceptor.** Check against spec 8.2: Redis `SET NX` fast path with the
      database row as durable truth, `409` for a changed body, `409 REQUEST_IN_PROGRESS` with `Retry-After: 2`,
      24-hour replay. Apply to every money-moving route (refunds, payouts, batches). Add the concurrency tests.
- [ ] **P4-09 VERIFY and BUILD. Outbox against the full requirement.** Phase 5 built it minimally (write side,
      dispatcher, three handlers). Check: written in the same transaction as the state change; claim with
      `FOR UPDATE SKIP LOCKED`; 60-second claim expiry; exponential backoff; alert on exhausted attempts;
      processor registered in `src/jobs/jobs.module.ts`; safe duplicate processing; hold events (`hold.created`,
      `hold.released`, hold expiry) go through it.
- [ ] **P4-10 BUILD. Gateway chase job** (`gateway-chase` queue): select eligible `processing` transactions; query by
      external id; handle success, failure, still pending and gateway timeout; deterministic job ids so queries are
      not duplicated; stop on terminal; metrics; feed reconciliation when unresolved. Name-route with sandbox steps
      (P3-13).
- [ ] **P4-11 BUILD. Scheduler** in the consumer process for jobs with no trigger today: payment expiry sweep
      (`PaymentExpiryService.sweep`), hold expiry sweep (`HoldsService.expireDue`, every minute), outbox dispatch,
      gateway chase. Check which Phase 5 to 9 schedules already cover some of these.
- [ ] **P4-12 BUILD. Approvals routes.** The tables and maker-checker exist (Phase 8). Build the routes that wait on
      them: `POST /admin/v1/journal-entries/adjustment`, `.../:ref/reverse` (approval always required),
      `POST /admin/v1/holds`, hold release and capture, payout and refund approve and reject, force-resolve
      (P4-D9). State machine `pending | approved | rejected | expired`, idempotent decisions, audit of every action.
      Move Phase 6 reconciliation resolution requests to the shared workflow (P6-04).
- [ ] **P4-13 BUILD. Disbursement and refund handlers (12 of the 18)** in the consumer (completes P3-09).
- [ ] **P4-14 BUILD. Permissions, scopes, errors and config.** New staff and merchant permissions and API key scopes
      with the migration seed and the `permissions.ts` versus database test; new codes in
      `src/common/errors/catalogue.ts`; new variables in `src/config/env.schema.ts` and `.env.example` together.

### Tests Phase 4 must add

- [ ] **P4-T1** Unit, integration, gateway contract, concurrent-request, idempotency, duplicate-event, failure-path,
      ambiguous-outcome, ledger-posting, hold capture and release, and approval tests.
- [ ] **P4-T2 Concurrency:** 50 parallel identical payment requests give one payment; parallel refunds cannot exceed
      the payment; parallel payouts cannot overdraw; parallel hold captures succeed once.
- [ ] **P4-T3** End-to-end payment against a mocked gateway that lands correctly in the ledger.
- [ ] **P4-T4** Update the minor-unit column inventory in `test/integration/ledger-schema.int-spec.ts` for every new
      money column.
- [ ] **P4-T5** Query plans under `docs/query-plans/` for holds, outbox claim, chase selection and consumer cursor.
- [ ] **P4-T6 DOC** Regenerate `docs/openapi/*.json` (see section 10); update `ARCHITECTURE.md`, `DATABASE.md`,
      `SECURITY.md`; write `LEDGER.md` and `OPERATIONS.md` runbook entries for the new failure modes.

**Phase 4 exit (spec section 14):** a payment runs end to end against a mocked gateway and lands correctly in the
ledger; the concurrency suite passes; typecheck, lint, unit and integration tests pass; migrations apply; no
unresolved architectural conflict.

---

## 4. Phase 5: Developer platform

Committed as `27d47a0`. Last run: 85 files, 1,261 tests. Exit criterion met for collections only. See
`ARCHITECTURE.md` ("Developer platform (Phase 5)", "Phase 5 decisions to confirm"), `SECURITY.md`, `API_PUBLIC.md`.

### Build, blocked by Phases 3 and 4

- [ ] **P5-01 BUILD. `/v1` route groups:** payment-methods, refunds, payouts, payout-batches, customers,
      settlements, disputes. Scopes exist. Refunds and payouts depend on section 3; settlements on Phase 6 (built);
      disputes on Phase 7 (built, see P7-02). Each needs an OpenAPI entry, tests, idempotency and audit.
      `API_PUBLIC.md` still lists `settlements` as not built; update it (X-DOC-1).
- [ ] **P5-02 BUILD. Sandbox simulation for payouts and refunds** once those routes exist.
- [ ] **P5-03 TEST. Re-prove signing and rate limits on the real routes.** They are proven only on the test probe
      (`/v1/__probe/payouts`, `/v1/__probe/refunds` in `test/support/developer.ts`). Re-prove on the real payout and
      refund routes, then remove the probe.
- [ ] **P5-04 TEST. Sandbox boundary on the real client.** `sandbox-boundary.spec.ts` checks imports statically.
      Add a test that the real Gateway client calls `assertGatewayEligible(environment)` before every request
      (with P3-02).
- [ ] **P5-05 BUILD. One processor for `gateway-chase`** that routes `sandbox.step` and the chase job by name
      (same as P3-13).
- [ ] **P5-06 VERIFY. Outbox against the full requirement** (same as P4-09; one task, do it once).

### Decisions to confirm

- [ ] **P5-D1 Webhook ordering.** Per-endpoint ordering needs BullMQ Pro groups, a paid dependency. Choose: buy it, or
      accept unordered delivery and give merchants `created_at` and event id as the ordering key. _Default:_
      unordered (current).
- [ ] **P5-D2 Signing key.** Separate `mpsig_` secret per API key, AES-GCM encrypted in `api_keys.signing_secret_enc`,
      shown once, header `v1=<hex>`. Confirm.
- [ ] **P5-D3 Signed path** includes the query string (`request.raw.url`). Confirm.
- [ ] **P5-D4 Mandatory signing** for live keys with `payouts:write`. Confirm (links to P4-D3).
- [ ] **P5-D5 Replay window** `2*tolerance+5` seconds; identical requests signed in the same second count as a
      replay; Redis down gives 503 for signed requests. Confirm.
- [ ] **P5-D6 Sandbox outcome mapping.** Last two digits of the amount: 01 fail, 02 timeout, 03 expire, 04 pending
      then succeed, else succeed; `metadata.simulate` overrides; unknown value is 422 in test mode. Delays:
      `SANDBOX_TIMEOUT_RESOLVE_SECONDS` 120, `SANDBOX_PENDING_SECONDS` 5. The spec gives no mapping. Confirm.
- [ ] **P5-D7 No endpoint verification** on webhook endpoints (spec says "where specified" and specifies nothing).
      Confirm.
- [ ] **P5-D8 Auto-disable notice.** After 50 consecutive failures the merchant gets
      `webhook_endpoint.auto_disabled` and an audit row. Phase 8 now provides email and in-app notifications. Decide
      whether to send one.
- [x] **P5-D9 API key format. DECIDED (owner): Stripe-style keys, publishable and secret, test and live.** The spec
      contradicted itself (`mp_{live|test}_{keyId}_{secret}` at lines 89, 1011 and 1525; `sk_` at line 322) and the code
      follows the `mp_` form. This decision **amends the spec**; task P5-K6 records that. Resulting formats:

      | Key         | Format                           | Secret part | Stored                         |
      | ----------- | -------------------------------- | ----------- | ------------------------------ |
      | Secret test | `sk_test_{keyId}_{secret}`       | 64 hex      | SHA-256 of the secret          |
      | Secret live | `sk_live_{keyId}_{secret}`       | 64 hex      | SHA-256 of the secret          |
      | Pub. test   | `pk_test_{keyId}`                | none        | key id only                    |
      | Pub. live   | `pk_live_{keyId}`                | none        | key id only                    |

      `keyId` stays 16 characters of `[a-z0-9]`, so the Redis lookup `apikey:{keyId}` (spec 8.3), the unique index and
      the timing-safe hash comparison do not change. A publishable key is an identifier, safe to embed in a browser or
      app, and can be displayed again after creation; a secret key is shown once. Follow-up tasks P5-K1 to P5-K6.

- [ ] **P5-D10 IP-allowlist denial** returns the same 401 as a wrong key. Decide on a distinct code for the key owner.
- [ ] **P5-D11 Webhook retry schedule** 0 / 30s / 2m / 10m / 1h / 6h / 24h, 7 attempts, jitter ±20%, kept in Postgres;
      BullMQ `attempts=3` for infrastructure faults only. Confirm.
- [ ] **P5-D12 Replays** are not deduplicated (each replay is a new delivery row). Decide: rate-limit, dedupe, or
      accept.

### Security items

- [ ] **P5-S1 Shared NAT.** The failed-auth limiter (per IP, per /64) can block clients behind one address. Tune
      `RATE_LIMIT_AUTH_FAILURE_PER_MIN` or key it differently.
- [x] **P5-S2 Stale cached API keys.** SQL-side changes leave a key valid up to 60 s (negative cache 30 s). Document in
      the incident runbook (`OPERATIONS.md`) or add a database notification to evict.
      _Result:_ Documented in OPERATIONS.md 'Compromised API key': a SQL-side change leaves a cached key valid for
      up to 60 s (KEY_CACHE_TTL_SECONDS) and a missing key cached as missing for 30 s (KEY_NEGATIVE_TTL_SECONDS);
      application changes evict at once. No database notification was added.
- [ ] **P5-S3 Redis outage.** Writes get 503, reads fail open (rate limits skipped). Decide if fail-open reads are
      acceptable. Add a test for the chosen behaviour.
- [x] **P5-S4 `TRUST_PROXY`** must be correct in production. Add a deployment check (`DEPLOYMENT.md` plus a
      startup assertion or readiness check).
      _Result:_ Both parts exist: env.schema.ts refuses to boot in production with TRUST_PROXY empty (covered in
      env.schema.spec.ts) and DEPLOYMENT.md lists it among the production refusals.
- [ ] **P5-S5 Single `DATA_ENCRYPTION_KEY`** encrypts signing and webhook secrets. Closed by P9-D2 (ENC-1).
- [x] **P5-S6 Partitions and retention** for `api_request_logs` and `webhook_deliveries` (about 4 months of partitions,
      90-day retention). Check that Phase 9 migration `0009_hardening_partitions_retention.sql` covers these two
      tables. _Done when:_ a test or a query proves partitions exist beyond four months and retention runs.
      _Result:_ Migration 0009 policies cover api_request_logs and webhook_deliveries (90 days).
      test/integration/data-lifecycle.int-spec.ts proves the current month plus three ahead are created, retention
      drops partitions at the boundary, and a webhook partition with a pending delivery is kept.
- [ ] **P5-S7 Personal data in request logs** (client IP, user agent). Decide the retention and the privacy basis.
- [ ] **P5-S8 Delivery response excerpts** are stored 90 days and may contain echoed secrets or PII. Shorten or
      redact.
- [x] **P5-S9 Webhook secret rotation** sends two `v1` signatures during the grace period. Confirm the grace limit
      and that it cannot be extended indefinitely; add a test.
      _Result:_ Confirmed in code: graceHours is validated 0 to 72 (default 24); a rotation keeps at most one
      previous secret, and it is the secret being replaced, so chaining rotations retires the older one at once
      and no secret signs longer than 72 hours after it stopped being current. Two tests added to webhook-
      endpoints.int-spec.ts (passes with the other 37).

### API key format change (from P5-D9)

Production has taken no live money, so no live key should exist. P5-K1 confirms that before the old format is
removed; if any key exists outside development, add a dual-format parse window first.

- [ ] **P5-K1 VERIFY. Existing keys.** Query `core.api_keys` in every environment (dev, staging, any shared
      database). _Done when:_ you have the count per environment. If zero outside development, drop `mp_` with no
      compatibility parse; otherwise keep parsing `mp_` read-only until each key is rolled, then remove it.
      _Result:_ Cannot be answered from this checkout: it needs a query of core.api_keys in each environment.
      Until it is, the mp_ prefix is still parsed (read only) so no existing key breaks. Remove LEGACY_PREFIX in
      api-key-format.ts and the legacy test once the count is zero outside development.
- [x] **P5-K2 BUILD. Format and parsing.** `src/modules/api-keys/api-key-format.ts`: replace `KEY_PATTERN` with one
      accepting `sk_{live|test}_{16}_{64 hex}` and `pk_{live|test}_{16}`; return `kind` (`secret` or `publishable`)
      with `environment` and `keyId`; `generateApiKey(kind, environment)`; `keyPrefix` returns `sk_test_{keyId}` or
      `pk_test_{keyId}`. Update `api-key-authenticator.service.ts`, `api-keys.service.ts`, `api-key.views.ts`, the
      OpenAPI `bearerFormat` in `src/common/openapi/public-api-document.ts`, and regenerate `docs/openapi/*.json`.
      The `mp_refresh` and `mp_csrf` cookie names are unrelated and stay.
      _Result:_ api-key-format.ts parses sk_ and pk_ (and the legacy mp_ read-only), returns kind, and generates
      sk_ keys; the authenticator, views and OpenAPI bearerFormat follow; docs/openapi regenerated. The mp_ prefix
      is still parsed: removing it needs the K1 answer.
- [x] **P5-K3 BUILD. Migration.** Add `api_keys.kind text not null default 'secret'` with a check
      `kind in ('secret','publishable')`; make `secret_hash` nullable with a check that it is null exactly when
      `kind = 'publishable'` (keep the 64-hex format check when present); keep the `key_id` format check. Publishable
      keys also need an origin allowlist (`allowed_origins text[]`), because an IP allowlist is meaningless for a
      browser. Signing (`signing_secret_enc`, `signing_required`) must be null/false for `publishable`. Use
      `npm run db:generate` then `npm run db:migrate`.
      _Result:_ Migration 0011_api_key_kinds: kind (default secret) with a check, secret_hash nullable exactly
      when kind = publishable, allowed_origins only for publishable, no signing on a publishable key. Constraint
      tests in api-key-security.int-spec.ts. Created with db:generate and applied by the integration global setup
      and migration-safety.int-spec.ts.
- [ ] **P5-K4 DECIDE. What a publishable key may do.** No `/v1` route is client-safe today, and the spec lists none.
      Checkout sessions already carry a `client_secret_hash`, which suggests the intended use: a browser or app
      completes or reads a checkout session with the publishable key plus that session's client secret. Proposed
      rule, to confirm: a publishable key can call only routes explicitly marked client-safe; it can never reach
      payouts, refunds, balances, customers, settlements, webhooks or key management; it carries no scopes beyond a
      fixed client-safe set; it is rate limited per IP and per key more tightly than a secret key; it needs a matching
      `Origin` for browser calls. Decide the exact route list. **Until this is answered, block creation of
      `publishable` keys** (the migration can ship; the issue route rejects the kind).
      _Result:_ Not decided. The DTO accepts only type 'secret' and the service refuses 'publishable' (tested),
      and the authenticator refuses pk_ keys on every route.
- [ ] **P5-K5 BUILD. Enforcement and tests.** A `@PublishableKeyAllowed()` decorator on client-safe routes; the
      authenticator rejects a `pk_` key on every other route with the same 401 as a wrong key; a test walks every
      `/v1` route and fails if a route allowing `pk_` also allows a write that moves money. Update the tests that
      hard-code `mp_`: `src/modules/api-keys/api-keys.spec.ts`, `test/integration/api-key-security.int-spec.ts`,
      `team-and-api-keys.int-spec.ts`, `rate-limiting.int-spec.ts`, `developer-api.int-spec.ts`. Keep the assertions:
      malformed, wrong environment, unknown key id, revoked, expired. Add: a `pk_` key presented where an `sk_` key is
      required, and a `sk_test_` key against live data.
      _Result:_ Partly done. The authenticator refuses a pk_ key with the same 401 as a wrong key, tested in api-
      key-security.int-spec.ts together with the pk_ form of a real key id; the tests that hard-coded mp_ now use
      sk_. The @PublishableKeyAllowed decorator and the route-walking test wait for P5-K4 (no route is client-
      safe).
- [x] **P5-K6 DOC. Amend the spec and the docs.** Edit `CORE_API_BUILD_PROMPT.md` at lines 89, 1011 and 1525 (and
      the schema note for `api_keys`) to the new formats, with a dated note that the owner decided it; update
      `API_PUBLIC.md`, `SECURITY.md`, `README.md`, the dashboard key-creation route and its OpenAPI entry (a `type`
      of `secret` or `publishable`). Add `sk_` and `pk_` patterns to log redaction (P9-SEC-LOG).
      _Result:_ Spec lines 89 (now the table row), the Keys paragraph of 6.11, 8.3 and the api_keys schema note
      amended with a dated note; API_PUBLIC.md, SECURITY.md and ARCHITECTURE.md updated; README has no key format
      text. The dashboard create-key OpenAPI entry carries type. Log redaction already covered sk_ (P9-SEC-LOG);
      pk_ is an identifier and is deliberately not redacted.
- [ ] **P5-K7 VERIFY. Secret scanning and tool confusion.** `sk_live_` and `pk_live_` are also Stripe's literal
      prefixes. Stripe's scanner pattern expects 24 or more alphanumeric characters straight after the prefix; our
      keys have 16 then an underscore, so they should not match. Confirm with a scanner (gitleaks or GitHub secret
      scanning) in both directions, and register a MulaPay-specific pattern (`sk_(live|test)_[a-z0-9]{16}_[0-9a-f]{64}`)
      so leaked keys are caught. Tell merchants in `API_PUBLIC.md` that these keys are not Stripe keys.
      _Result:_ Partly done. .gitleaks.toml registers the MulaPay patterns (sk_, legacy mp_, mpsig_, whsec_).
      Running gitleaks and GitHub secret scanning in both directions still has to be done where those tools run;
      API_PUBLIC.md now says these are not Stripe keys.

### Review and process

- [ ] **P5-R1 Review the existing tests Phase 5 changed** (none weakens a financial assertion; each is recorded in
      `ARCHITECTURE.md`): `admin.int-spec`, `transactions-queries.int-spec`, `docs-and-processes.int-spec`,
      `queue.int-spec`, `payments-api.int-spec`, `test-env.ts`, `global-setup.ts`.
- [ ] **P5-R2 Check the Prettier pass** (`prettier --write .` ran over the whole repository) did not alter
      `src/integrations/gateway/*` in a way you object to.
- [ ] **P5-R3 Watch for shared-database races** in integration suites (outbox dispatcher claiming another suite's
      rows). Prefer a unique `QUEUE_PREFIX` per context.

---

## 5. Phase 6: Settlement and reconciliation

Committed as `2b5e624`. Last run before commit: 97 files, 1,396 tests. Design: `RECONCILIATION.md`, `ARCHITECTURE.md`,
migration `0006_settlement_reconciliation.sql`.

### Decisions

- [ ] **P6-D1 Settlement credits `1010:provider_float:{provider}`, not `1100:bank`.** Spec 5.5 says `DR 1200 / CR
1100:bank`; spec 6.9 routes the payout through the gateway. **This is the one departure from the spec's own
      posting text. It is an architectural conflict: stop and decide.** One line in
      `settlement/domain/settlement-posting.ts` reverts it.
- [ ] **P6-D2 Reversals need approval,** not only write-offs (spec 6.6 and 11). Confirm.
- [ ] **P6-D3 Any ledger integrity finding opens a sev1,** including a non-empty suspense account.
      `SUSPENSE_ALERT_HOURS` is unused here. Phase 8 (decision 15) made the drift monitor defer to this incident.
      Decide which of spec 6.8 and spec 6.14 wins, and whether a grace period applies.
- [ ] **P6-D4 `reserved` stays 0** in the merchant balance (same as P4-D8). Confirm, or choose another model; that
      changes a balance calculation of an earlier phase.
- [ ] **P6-D5 Settlement payout is a `transactions` row of type `settlement`** with key `po_{ULID}`. Keep, or move to
      `payouts` when P4-06 lands.
- [ ] **P6-D6 Balance proof mapping:** clearing against the gateway `collection` balance, float against
      `disbursement`. Confirm.
- [ ] **P6-D7 Release is asynchronous** (route answers `releasing`, worker sends after commit). Confirm.
- [ ] **P6-D8 A completed settlement run is final for its period;** a batch cancelled afterwards settles in the next
      period. Confirm operationally.
- [ ] **P6-D9 Merchant events:** `settlement.created` on submit-for-approval, `settlement.paid` on pay, no
      `balance.updated`. Confirm.
- [ ] **P6-D10 New queue `reconciliation-run`** (concurrency 2, beyond the nine of spec 8.9) and `settlement-run`
      retries payout submission 8 times. Confirm.
- [ ] **P6-D11 `cron-parser` ^4.9.0** as a direct dependency (v5 is available; see P9-DEP-2). Confirm.
- [ ] **P6-D12 Permission names** `settlement:{read,prepare,approve,release}`, `reconciliation:{read,work,approve}`,
      `settlements:read`. Check role grants in migration 0006 (only `super_admin` approves; `operations` prepares and
      releases; `auditor`, `compliance`, `support_agent` read).
- [ ] **P6-D13 Exceptions addressed by `rce_` ref** and staff by `usr_` ref (spec writes `:id`). Confirm.

### Build

- [ ] **P6-01 BUILD. Real gateway client and consumer integration.** Implement `GatewayOperationsPort` in the full
      client (P3-02) and call `SettlementOutcomeService.apply` from the consumer (P3-09).
- [ ] **P6-02 BUILD. Phase 7 hold prefixes.** Settlement subtracts holds whose reason starts `dispute:` or `aml:`.
      Phase 7 uses `dispute:{ref}` and `aml:block:{ref}`. Add a test that runs a settlement cycle with holds created
      by a real dispute and a real block (not by hand).
- [ ] **P6-03 BUILD. Refunds in settlement.** Settlement reads succeeded `refund` transactions; no flow creates
      them. After P4-05, replace the hand-inserted refund in the integration test with a real flow.
- [ ] **P6-04 BUILD. Move resolution requests** from `reconciliation_resolution_requests` to the shared approvals
      workflow (Phase 8 built it).
- [ ] **P6-05 BUILD. Incident routes.** Phase 8 built the incident lifecycle; confirm the automatic sev1/sev2 openers
      (ledger integrity, failed consumer event) use it, and that the sev2 for a failed consumer event is raised by
      P3-08.
- [ ] **P6-06 BUILD. Statement presign.** `POST /admin/v1/reconciliation/statements/presign` is not built. Today
      statements are uploaded as rows (max 2,000, 256 KB). Needs the S3 integration (Phase 7 and 8 added it) and
      sets `provider_statements.file_key`.
- [ ] **P6-07 BUILD. Streamed CSV download** for the statement (today text inside the JSON envelope), with Phase 8
      report links.
- [ ] **P6-08 DECIDE. Bank destinations.** Only mobile-money payees can be paid (gateway party types MSISDN, EMAIL,
      PARTY_CODE). _Default:_ not supported. Needs a gateway change to enable.
- [ ] **P6-09 BUILD. `LEDGER.md`:** add the settlement and write-off posting patterns (currently only in
      `RECONCILIATION.md`).
- [ ] **P6-10 BUILD. Late-success remedy.** `late_conflicting_event` has no automatic remedy; add an "apply late
      success" tool or document the manual procedure in `OPERATIONS.md`.
- [ ] **P6-11 BUILD. Operator override for a long gateway outage** (see P4-D9).
- [ ] **P6-12 BUILD. Per-merchant settlement metrics and a batch-state dashboard.** Only five metrics exist
      (`core_settlement_batch_transitions_total`, `core_reconciliation_runs_total`,
      `core_reconciliation_exceptions_open`, `core_ledger_integrity_failures`, `core_suspense_balance_minor`).
- [x] **P6-13 TEST. Assignee check:** exceptions can be assigned to any active staff user. Require
      `reconciliation:read` or `work` and test it.
      _Result:_ Exception assignment now requires an active staff user whose role grants reconciliation:read or
      reconciliation:work (ReconciliationQueriesRepository.exceptionAssigneeIdByRef); anyone else is 404.
      settlement-api.int-spec.ts proves support_agent is refused and auditor (read only) is accepted.

### Verify

- [ ] **P6-V1 Transaction views and `settlement` rows.** Check `GET /v1/transactions`, filters, `transaction_events`
      and the timeline handle the `settlement` type and statuses, and decide whether a merchant should see it.
- [ ] **P6-V2 Fake gateway versus the real gateway** (`test/support/fake-gateway-ops.ts` was written from source, never
      run against it). Check against a running gateway: list endpoint newest-first order and no date filter,
      `accountType` on the balance route, the `collection` and `disbursement` balance meaning, the 409 on a reused
      `externalId`. See X-REAL-1.
- [ ] **P6-V3 Payout `externalId` uniqueness** against the gateway's (tenant, provider, operationType) rule.
- [ ] **P6-V4 Time zones.** Test the zones your cycles will use (only Kampala and New York are unit tested). See X-TZ-1.
- [ ] **P6-V5 Migration 0006 on a populated database** (CHECK, trigger on partitioned `core.transactions`, foreign key
      to `core.merchants`). Measure lock time. See X-MIG-1.
- [ ] **P6-V6 Worker boot end to end** through the outbox, queue and job. See X-WORKER-1.

### Risks to decide

- [ ] **P6-R1 60-second commit margin** (`COMMIT_SAFETY_MS`) vs transactions with many statements. Decide whether to
      raise it or assert a statement budget.
- [ ] **P6-R2 Read committed for batch creation** (repeatable read failed on the audit chain head row). Revisit if
      the audit write moves out of the transaction (see P9-D3 and P9-A8).
- [ ] **P6-R3 Settlement tick** runs every active cycle every minute and sweeps at most 50 releasing batches. Many
      cycles or stuck batches need another schedule or batch size.
- [ ] **P6-R4 Two staff for approval,** and only `super_admin` approves. A deployment with one super admin cannot
      approve its own submission. Decide staffing or a documented break-glass.
- [ ] **P6-R5 Write-off cap:** a write-off may not exceed the discrepancy and may only clear platform asset accounts.
      Document the route for larger losses (new exception or manual adjustment, P4-12).
- [ ] **P6-R6 Load test** a cycle over many merchants and the balance proof (about four queries per merchant;
      integrity run recomputes every balance; gap run capped at `RECON_GATEWAY_LOOKUPS_PER_RUN` 200). See X-LOAD-1.

### Review

- [ ] **P6-R7 Review files Phase 6 changed:** `permissions.ts`, `catalogue.ts`, `ids.ts`, `queue.definitions.ts`,
      `metrics.ts`, `metrics.service.ts`, `env.schema.ts`, `.env.example`, `job-schedulers.ts`, `jobs.module.ts`,
      surface modules, `db/schema/index.ts`, `package.json`, `AGENTS.md`; and tests whose expectations changed:
      `admin.int-spec`, `docs-and-processes.int-spec`, `ledger-schema.int-spec`, `queue.spec`, `jobs.int-spec`,
      `test/support/identity.ts`.
- [ ] **P6-R8 Flaky tests under load:** `rate-limiting.int-spec`, `ledger-concurrency.int-spec` (deadlock test),
      `jobs.int-spec` (webhook recovery counts jobs in a shared Redis queue), the Phase 6 test "parallel runs of one
      window never run twice" (failed once, passed three times alone). Find the cause or make them deterministic.
- [ ] **P6-R9 Test isolation pairs.** Do not reuse airtel/TZS, flutterwave/GHS, or test/MWK in other suites.
      Integrity tests inject corruption with `session_replication_role = replica`; after a killed run, recreate the
      database.

---

## 6. Phase 7: Compliance

Committed as `c84f877`. Last full run (before the split): 114 files, 1,561 tests. `src/modules/kyc` branches at 78%.
Design: `ARCHITECTURE.md` ("Compliance (Phase 7)", "Phase 7 decisions to confirm"), `DATABASE.md`, `SECURITY.md`.
Migration `0007_compliance.sql`.

### Must be done by compliance before any live merchant

- [ ] **P7-C1 Set the real limits per KYC level.** `kyc_level_limits` is seeded with placeholder USD-based values
      (level 1: 300 per transaction, 1,000 a day, 5,000 a month; level 2: 3,000, 20,000, 200,000; level 3: 30,000,
      200,000, 2,000,000) at rounded rates.
- [ ] **P7-C2 Review and enable the eight seeded AML rules per currency.** All are disabled, so nothing is monitored
      until then. Name an owner and a date. **Add a startup or readiness warning when no rule is enabled** (the
      risk list notes there is no signal today).
      _Result:_ The signal part is built (progress note, not a tick: Compliance still has to review and enable the
      rules and name an owner and date). core_aml_rules_enabled counts rules enabled and in effect (alert at 0)
      and the api process logs a warning at boot when it is 0. Tests: aml-monitoring-coverage.service.spec.ts and
      an integration case in aml-monitoring.int-spec.ts.
- [ ] **P7-C3 Review KYC requirement seeds** per country and business type for every country served.

### Decisions

- [ ] **P7-D1 A confirmed PEP match blocks activation.** Many regimes treat a PEP as enhanced due diligence. Compliance
      decides.
- [ ] **P7-D2 Expiry has no limit consequence** (spec 6.13 silent). The mechanism exists
      (`kyc_level_limits.applies_when = 'expired'`). Decide whether to restrict expired merchants.
- [ ] **P7-D3 Policy defaults that are mine:** KYC validity 365 days, review score 0.7, confirm 0.9, alert SLA 72,
      24, 8 and 4 hours by severity. Confirm.
- [ ] **P7-D4 A dispute lost with too little posted balance** is refused (409 `INSUFFICIENT_BALANCE`) unless staff pass
      `acceptDeficit`, which leaves a negative merchant payable. Confirm the policy.
- [ ] **P7-D5 A dispute is never refused for lack of funds at opening;** available is held and the rest recorded as
      `shortfall_minor`. Confirm.
- [ ] **P7-D6 Lost-dispute accounting:** whole-payment loss reverses the collection entry through `ReversalService`;
      partial loss posts `DR merchant_payable / CR provider_clearing` (source `adjustment`). Spec 6.14 says "a
      reversing entry". Confirm the accounts.
- [ ] **P7-D7 Document statuses** stay `uploaded|verified|rejected` (spec 5.2), not the request's
      `pending|approved|rejected`. Confirm.
- [ ] **P7-D8 Additive differences from spec 5.2:** `ubo` screening subject, `contact` check type, `kyc_parties`
      instead of `merchant_profiles.directors jsonb`, `aml_alerts.case_id` instead of `alert_ids uuid[]`, rule
      effective dates, append-only `aml_rule_versions`. Confirm.
- [ ] **P7-D9 Added routes and permissions** not in the spec (KYC profile, parties, checks, requirements CRUD,
      `POST /admin/v1/aml/rules`, screening decisions, blocks, `POST /admin/v1/disputes`; permissions
      `kyc:view|submit`, `disputes:read|write`, `kyc:read|review|approve|view_documents|requirements`,
      `aml:read|work|rules|blocklist|block|str`, `chargebacks:read|work|resolve`). Check the role grants in
      migration 0007.
- [ ] **P7-D10 SigV4 by hand versus the AWS SDK.** Verified against AWS test vectors only. Decide whether to keep it
      (also used by Phase 8 multipart and POST/query signing) or adopt the SDK.
- [ ] **P7-D11 Maker-checker for KYC approval** needs two staff. Confirm (links to P6-R4).
- [ ] **P7-D12 A block holds the balance at that moment** and suspends payouts; later money is not held. Tipping-off
      wording differs by jurisdiction. Confirm with legal.
- [ ] **P7-D13 Closing an AML case needs no step-up** (a route cannot conditionally require it). Resolving an alert
      and generating an STR do. Confirm.
- [ ] **P7-D14 STR package layout** (names decrypted; ID numbers and TIN as the last four characters). Confirm
      against the regulator's format.
- [ ] **P7-D15 Review queues are newest-first** (pagination helper is descending only). An oldest-first SLA
      worklist is unavailable. Decide whether to extend the pagination helper.
- [ ] **P7-D16 Volume counters use UTC days and months,** not the merchant's local day. Confirm (X-TZ-1).
- [ ] **P7-D17 Counter rebuild source.** Currently `transactions`; spec 6.13 names `daily_merchant_rollups` (built in
      Phase 8). Decide whether to switch.
- [ ] **P7-D18 `complyadvantage`:** the schema accepts it, no adapter exists (fails closed). Build it or remove it
      from the schema.

### Build

- [ ] **P7-01 BUILD. Payout and refund controls.** The payouts and refunds modules (P4-05, P4-06) must call
      `assertPayoutsAllowed` and `isSuspended`. **A money-out path that skips them ignores blocks.** Add a test that
      fails when any money-out route lacks the check.
- [ ] **P7-02 BUILD. Public `/v1/disputes`** (spec 7.1). Same as P5-01; build once.
- [ ] **P7-03 BUILD. Chargebacks from the gateway.** The consumer (P3-08) must create disputes from provider events.
- [ ] **P7-04 BUILD. Payout limit enforcement** (same as P4-04).
- [ ] **P7-05 BUILD. Virus scanning** for uploaded KYC documents (only type, size, magic bytes, checksum today).
- [ ] **P7-06 BUILD. Retention and deletion** of KYC documents and personal data: a retention job and an erasure route
      for `kyc_documents`, `kyc_parties`, `merchant_profiles`. Add the rows to the Phase 9 retention table.
- [ ] **P7-07 BUILD. `LEDGER.md`:** dispute posting patterns.
- [x] **P7-08 DOC. README** environment variable list against the 12 new variables.
      _Result:_ README now carries a variable reference generated from .env.example; src/config/readme-env.spec.ts
      fails when they diverge.
- [ ] **P7-09 TEST. Restore the p99 assertion** for the pre-check (target 20 ms; only the median is asserted, under 10
      ms). Run it in the `load` project on quiet hardware, not in the parallel suite.
- [ ] **P7-10 TEST. Raise `src/modules/kyc` branch coverage** (78%, 92.6% lines).
- [ ] **P7-11 BUILD. Key rotation for encrypted columns** (TIN, names, dates of birth, ID numbers). Closed by P9-D2.
- [ ] **P7-12 BUILD. Alert for a screening outage.** After 8 retries a job sits in the dead-letter set and the
      merchant stays unscreened. Alert on it and document the retry procedure.
- [ ] **P7-13 VERIFY. Counter drift.** A payment declined later in the same transaction leaves its volume counted
      until a rebuild; counters exact only below 2^53 minor units. Add a scheduled rebuild or a drift check.
- [x] **P7-14 VERIFY. Fail-closed behaviour.** Redis down gives 503 on payment creation; a merchant with no limits for
      level and currency is declined. Confirm this is the intended policy and test it.
      _Result:_ Both behaviours are already tested: 'declines a live merchant that has no limits at all' and
      'fails closed when Redis cannot answer: the payment is declined with 503 and nothing is written' in
      test/integration/aml-controls.int-spec.ts. The policy (fail closed) follows the financial-system rule that a
      control that cannot answer must not let money through; the owner still has to confirm it as the intended
      policy.

### Verify

- [ ] **P7-V1 Real S3-compatible store** (presigned PUT and GET, HEAD and ranged GET, SSE header,
      `x-amz-checksum-sha256`, path-style). X-REAL-2.
- [ ] **P7-V2 OpenSanctions against the real API** (response shape, scoring, timeouts). X-REAL-3.
- [ ] **P7-V3 Pre-check latency** over a network with a loaded Redis and real concurrency (measured: median 0.68 ms,
      p99 2.0 ms on one machine).
- [ ] **P7-V4 Tipping-off audit.** Re-audit every merchant-facing response, event and webhook for text that reveals an
      alert, case, screening or block reason.
- [ ] **P7-V5 Migration 0007** on a populated database. X-MIG-1.
- [ ] **P7-V6 Worker boot end to end** (`aml-screen` and its three schedules). X-WORKER-1.
- [ ] **P7-V7 Merchant local midnight** behaviour. X-TZ-1.

### Review

- [ ] **P7-R1 Review files Phase 7 changed:** `auth-core.module.ts`, `permissions.ts`, `catalogue.ts`, `ids.ts`,
      `queue.definitions.ts`, `metrics.ts`, `env.schema.ts`, `.env.example`, `job-schedulers.ts`, `jobs.module.ts`,
      `event-types.ts`, `merchants.repository.ts`, `payment-creator.ts` (pre-check before any write),
      `payment-lifecycle.service.ts` (queues monitoring in the same transaction), `payments.module.ts`,
      `settlement-release.service.ts`, `settlement.module.ts`, surface modules, `db/schema/index.ts`, `AGENTS.md`.
      Tests changed: `admin.int-spec`, `ledger-schema.int-spec`, `queue.spec`.
- [x] **P7-R2 Production env:** `PII_HMAC_PEPPER` required in production; `S3_SERVER_SIDE_ENCRYPTION` required when
      `S3_BUCKET_DOCUMENTS` is set; screening works only with `SANCTIONS_PROVIDER` and `SANCTIONS_API_KEY`. Add to
      `DEPLOYMENT.md` if missing.
      _Result:_ PII_HMAC_PEPPER and S3_SERVER_SIDE_ENCRYPTION were already in DEPLOYMENT.md; the sanctions
      provider and key requirement was missing and is now added.
- [ ] **P7-R3 Commit split.** Phase 7 was not re-run after the split from Phase 6. Run the full suite on `c84f877`
      (or rely on P9's later run).
- [ ] **P7-R4 Flaky:** `sandbox.int-spec` (delivery processor), `webhook-delivery.int-spec` (secret rotation timeout,
      same suite as P8-T1), `jobs.int-spec` (expected 129, got 130 once).
- [ ] **P7-R5 Test discipline:** AML tests use XAF, dispute tests XOF; any test that edits a role, rule or limit
      must restore it; the fixed clock advances 30 s per staff login.

---

## 7. Phase 8: Support and operations

Committed as `682e149`. Last full run: 129 files, 1,721 tests with `--maxWorkers=3`. Design: `ARCHITECTURE.md`
("Support and operations (Phase 8)"), `DATABASE.md`, `OPERATIONS.md`, `LOAD_RESULTS.md`. Migration
`0008_support_operations.sql`.

### First

- [ ] **P8-01 VERIFY. Re-run the load test** on suitable hardware and profile `POST /v1/payments` and the 6-line
      ledger posting. See X-LOAD-1.
- [ ] **P8-02 VERIFY. Run the vendor and storage adapters** (Resend or Postmark, Africa's Talking, FCM, S3 multipart)
      against real services in staging. See X-REAL-4.
- [ ] **P8-03 VERIFY. Re-check the consumer runbooks** when Phase 3 lands: "Consumer lag" (lease takeover,
      idempotent apply, skipping a rejected event) and "Stuck transaction" (resolved by gateway event or status
      check). Update `OPERATIONS.md` and `runbooks.int-spec.ts`.
- [ ] **P8-04 DECIDE. Test worker count.** Set `maxWorkers` in `vitest.config.mts` or document the flag for
      developers and CI. See section 10.

### Decisions: differences from the spec

- [ ] **P8-D1** Notification templates are unique on (code, channel, locale), not `code` (spec 5.2). Confirm.
- [ ] **P8-D2** `daily_merchant_rollups` has `environment` in its primary key. Confirm.
- [ ] **P8-D3** Notification rows are per user; merchant and staff-group audiences expand before insert. Confirm.
- [ ] **P8-D4** `notification_deliveries` is partitioned monthly; `notifications` is not. Confirm.
- [ ] **P8-D5** `consumer_cursors` was created in 0008. P3-06 must adopt it. Confirm there is one table.
- [ ] **P8-D6** Extra queue `support-ops` (concurrency 1, one attempt). Confirm or fold into another queue.
- [ ] **P8-D7** Reports are CSV and JSON only; `xlsx` and `pdf` answer `REPORT_INVALID`. The payouts and refunds
      reports read `transactions` by type; switch to the payout and refund tables after P4-05 and P4-06.
- [ ] **P8-D8** Added behaviour: staff can file a complaint for a customer or merchant; contact reveal route with
      audit; notification destinations routes (dashboard and admin). Confirm.
- [ ] **P8-D9** Vendors: Resend, Postmark, Africa's Talking, FCM HTTP v1. `ses` and `twilio` are accepted by the
      schema with no adapter (fail closed, retried, then `failed`). Build them or remove from the schema.

### Decisions: placeholder policy values

- [ ] **P8-D10** Complaint SLAs (`complaint_categories.sla_hours`, `other` 96 h; calendar time, not business hours).
- [ ] **P8-D11** Incident thresholds: `OPS_STUCK_TXN_MINUTES` 15 (sev3; sev2 from 60), `SUSPENSE_ALERT_HOURS` 1 (sev2;
      sev1 from 24), `OPS_QUEUE_DEPTH_THRESHOLD` 1,000 for 300 s (sev3; sev2 at five times); a cleared signal moves an
      incident to `monitoring` only.
- [ ] **P8-D12** `OPS_FLAG_CHANGE_APPROVAL` default `production`; `APPROVAL_TTL_HOURS` 24; broadcast cap 1,000.
- [ ] **P8-D13** Public status feed: component whitelist, 14-day window, 30-second cache, headline is
      `public_message`.
- [ ] **P8-D14** Reports: `REPORT_MAX_ROWS` 5,000,000, `REPORT_MAX_ACTIVE_PER_MERCHANT` 5, 15-minute link, 7-day file
      life (constants), schedule recipients limited to merchant members or staff, mandatory templates (security,
      disputes, SLA breach, incidents), rollup recompute window (today; yesterday in the first hour; previous days
      at 01:30 UTC).

### Decisions: behaviour

- [ ] **P8-D15 Suspense reported twice.** Phase 6 opens a sev1 at once; Phase 8's drift monitor stays quiet while a
      `ledger_integrity` incident is open. Confirm one incident, or decide which spec wins (same as P6-D3).
- [ ] **P8-D16 Provider disable is conditional:** applies at once only if another enabled provider covers every routed
      currency; deleting a rule or disabling the last enabled rule of a currency needs approval. Confirm.
- [ ] **P8-D17 Maintenance mode fails open** when its row is unreadable, and exempts the switch and sign-in, refresh,
      MFA and step-up. Confirm the list; decide if fail-open is acceptable for a financial system.
- [ ] **P8-D18 A notification may be sent twice, never zero times** (5-minute lease; only email has an idempotency
      key). Confirm.
- [ ] **P8-D19 Report generation is not resumable;** failed attempts restart, failed uploads abort. Confirm.
- [ ] **P8-D20 Roles:** `operations` holds `ops:manage` and `ops:approve`; roles with `reports:platform` also hold
      `audit_logs:read`, `ledger:read`, `reconciliation:read`; no step-up on incidents, broadcasts, template edits,
      report requests. Confirm each.

### Build

- [ ] **P8-05 BUILD. `GET /admin/v1/ops/gateway-health` and `POST /admin/v1/ops/gateway/replay-events`** (need the
      gateway client, P3-02). Consumer heartbeat and cursor via P3-08 (the cursor route reports `never_started`).
- [ ] **P8-06 BUILD. Staff report schedules** (platform reports). Merchants have them.
- [ ] **P8-07 BUILD. `xlsx` and `pdf` report formats** (or document them as out of scope).
- [ ] **P8-08 BUILD. Redis pub/sub invalidation** of the feature-flag cache (today bounded by a 2-second in-process
      cache).
- [x] **P8-09 BUILD. Partition automation and retention for `notification_deliveries`** (180-day). Phase 9 migration
      0009 may cover this: verify; rows after four months land in the default partition.
      _Result:_ Covered by migration 0009 (notification_deliveries, 180 days) and the data-lifecycle spec test
      'applies 180 days to notification deliveries'; partition_status reports months ahead and default-partition
      rows.
- [ ] **P8-10 BUILD. Retention and erasure** for complaints (customer contact), notification addresses and report
      files beyond the 7-day expiry.
- [ ] **P8-11 BUILD. Public API groups** (same as P5-01): refunds, payouts, payout-batches, customers,
      payment-methods, settlements, `/v1/disputes`. "OpenAPI complete" holds only for routes that exist.
- [ ] **P8-12 BUILD. Per-endpoint webhook ordering** (same as P5-D1).
- [x] **P8-13 DOC. README** environment variable list against the new variables.
      _Result:_ Same README reference and guard spec as P7-08.

### Verify

- [ ] **P8-V1 Real vendors:** email, SMS, push (response shapes, auth, rate limits, FCM token exchange). X-REAL-4.
- [ ] **P8-V2 Real S3 multipart upload:** `putStream`, SigV4 POST and query strings, 5 MiB minimum part, abort path.
      X-REAL-2.
- [ ] **P8-V3 Report cursor on a real read replica.** A `REPEATABLE READ READ ONLY` cursor held up to 10 minutes
      (`idle_in_transaction_session_timeout` raised with `SET LOCAL`) can conflict with replication
      (`max_standby_streaming_delay`) and is untested through PgBouncer. Profile memory at a realistic file size.
- [ ] **P8-V4 Maintenance mode** across several processes and with an unreadable database.
- [ ] **P8-V5 Runbooks walked through by a person** in a real environment (21 runbooks; tests use seeded failures).
- [ ] **P8-V6 Migration 0008** on a populated database. X-MIG-1.
- [ ] **P8-V7 Worker boot end to end** (`support-ops`, `notification-send`, `report-generate`, `rollup-aggregate`).
      X-WORKER-1.
- [ ] **P8-V8 Time zones** for rollups and SLA windows (UTC and calendar time). X-TZ-1.
- [ ] **P8-V9 Public status feed.** A person reads real incident wording against the whitelist.

### Test problems

- [ ] **P8-T1 FIX. `webhook-delivery.int-spec`** failed in two early full runs (a delivery returned `skipped` where
      `retry_scheduled` was expected; a signature test got no header). Cause not found. Phase 8 added a second
      outbox row (`notification.merchant_event`) on the same path, so rule that out with a targeted test.
- [ ] **P8-T2 DECIDE. Default Vitest worker count** (see P8-04). One full default run took 2,321 s and failed 117
      tests; `--maxWorkers=3` takes about 160 s and passes.
- [ ] **P8-T3 TEST. Isolation.** Three databases (`mulapay`, `mulapay_isolated`, `mulapay_runbooks`), Redis databases
      0 to 2. A suite that changes global state (maintenance mode, flags, providers, routing rules, the cursor) or
      reads every transaction must use `startSupportContext` with `isolated`; two suites must not share one isolated
      database. Add a guard test or a lint rule if practical.
- [ ] **P8-T4 FIX. Clock mismatch.** Tests use `FixedClock`, the container uses its own clock; any test comparing a
      stored timestamp with `now()` can flake. Find those tests and use one clock.

### Review

- [ ] **P8-R1 Review the defect fixes:** the notification double-send fix (`lockPending` requires the delivery to be
      due; retry tests advance the clock), same-millisecond ordering (repositories bump `created_at` by 1 ms; touched
      `incidents`, `complaints`, `disputes`), the approval-decision trigger (migration 0008 edited before release),
      Redis key prefixes.
- [ ] **P8-R2 Review files Phase 8 changed:** `app.module.ts` (global `MaintenanceGuard` before auth),
      `global-exception.filter.ts`, `catalogue.ts` (19 new codes), `permissions.ts`, `ids.ts`, `queue.definitions.ts`,
      `metrics.ts`, `env.schema.ts`, `.env.example`, `job-schedulers.ts`, `jobs.module.ts`,
      `merchant-events.service.ts`, `src/modules/incidents/*`, `src/modules/disputes/*`, `db/schema/incidents.ts`,
      `disputes.ts`, `src/integrations/storage/*`, `public-api-document.ts`, `vitest.config.mts`, `package.json`,
      `.gitignore`, `global-setup.ts`, `AGENTS.md`, `README.md`.
- [ ] **P8-R3 Review tests changed:** `queue.spec`, `admin.int-spec`, `docs-and-processes.int-spec`,
      `ledger-schema.int-spec`, `api-key-security.int-spec`, `api-contract.int-spec`.

---

## 8. Phase 9: Production hardening

HEAD is `9274ec8`. **NOT READY FOR PRODUCTION.** Evidence: `PRODUCTION_READINESS.md`, `SECURITY.md` ("Phase 9
review"), `LOAD_RESULTS.md`, `docs/query-plans/README.md`.

### First actions

- [ ] **P9-01 VERIFY. Full suite on a machine with free memory:** `npx vitest run --coverage --maxWorkers=1`. The last
      complete run (1,844 passed, 3 expected fail) predates fixes DB-3 and DB-4.
- [ ] **P9-02 VERIFY. `npm run build && npm run test:chaos`.** The last whole-chaos run predates DB-3 and DB-4.
- [x] **P9-03 VERIFY. `npx eslint . --max-warnings 0`.** Lint was not re-run after the last edits.
      _Result:_ npx eslint . --max-warnings 0 passes at HEAD 7d33989 with no output.
- [ ] **P9-04 TEST. Chaos scenarios that could not run** (see P3-15): A, G (cursor half), consumer lag, queue depth
      and ledger integrity incidents.

### Architecture decisions (high severity)

- [ ] **P9-D1 DECIDE. DB-1: application role owns the schema.** `mulapay_core_rw` owns `core`; stolen credentials
      could disable append-only triggers, re-grant UPDATE and rewrite the ledger and audit log (three `it.fails` tests
      in `database-security.int-spec.ts` prove it). Option: separate owner/migrator from the application role.
      **Changes spec decision D2: stop and report.** When fixed, turn the three `it.fails` into plain `it`.
- [ ] **P9-D2 DECIDE. ENC-1: no KMS.** One raw key, no keyring, no re-encryption job; a key change or compromise makes
      every encrypted column unreadable (MFA, webhook and signing secrets, destinations, KYC fields).
      `FieldEncryption` refuses to run with `KMS_KEY_ID` set. Needs KMS-wrapped keys, a keyring that accepts previous
      keys, a re-encrypt job. Closes P5-S5 and P7-11.
- [x] **P9-D3 PERF-2: single audit hash chain. DECIDED (owner: "use the best option"): post-commit sequencer.**
      The problem: every audited write takes `FOR UPDATE` on `audit_chain_head` and holds it until commit, so the
      platform manages about 90 audited writes per second with 5 ms of work after the audit row and about 30 with
      20 ms; 76.7% of database time under the soak was that wait. Reproduce with `test/load/audit-chain.load-spec.ts`.

      | Option                  | Removes the lock from the request path | Keeps one platform-wide chain | Verdict |
      | ----------------------- | -------------------------------------- | ----------------------------- | ------- |
      | Per-merchant chains     | Only across merchants; a busy merchant, and every staff or system row (`merchant_id` null), still queue on one row | No: no ordering between merchants, and dropping a merchant's whole tail is undetectable without extra anchoring | Rejected |
      | Sharded chain (N heads) | Reduces contention by about N, never removes it | No: N chains to verify and anchor | Rejected |
      | **Post-commit sequencer** | **Yes: the request takes no shared lock** | **Yes** | **Chosen** |

      Why this one: the audit row is still written inside the business transaction, last (AGENTS.md rule: audit in the
      same `UnitOfWork.run`, so a change and its audit row commit or fail together). Only the hashing moves out. One
      background sequencer then chains committed rows in batches, which is cheap, because it is one writer doing
      sequential work. `GET /admin/v1/audit-logs/verify` still proves one platform-wide, ordered, tamper-evident chain
      under `hash = sha256(prev_hash || canonical(row))` (spec 6.14). What changes: a row is chained a short time after
      commit, not at commit.

      **Spec departure to record (P9-A9):** spec 5.2 puts `prev_hash` and `hash` on `audit_logs`. Those rows are
      append-only (triggers reject UPDATE), so the sequencer cannot fill them in later. The hashes move to a separate
      append-only table. Design constraints, all required:
      1. `audit_logs` loses `prev_hash` and `hash` (or they become nullable and unused; prefer removal) and gains
         `xid8` of the writing transaction (`pg_current_xact_id()`).
      2. New append-only `audit_chain(position bigint pk, seq bigint, created_at, prev_hash, hash)`, same
         `REVOKE`/`reject_mutation` protections as `audit_logs`, and `audit_chain_head` becomes sequencer-only.
      3. **Ordering gate.** `seq` is assigned at insert and can commit out of order, so the sequencer may chain only
         rows whose transaction finished: `xid < pg_snapshot_xmin(pg_current_snapshot())`. Chain order is the
         sequencer's `position`, not `seq`. Without the gate a row that commits late would be skipped, or the chain
         would be forced to rewrite.
      4. **One sequencer at a time:** a Postgres advisory lock held by the worker or consumer process; a second
         instance waits. Each batch (for example 500 rows) hashes in `position` order and commits rows and head
         together, so a crash leaves a consistent head.
      5. `verify` walks `audit_chain` by `position`, checks each hash against its `audit_logs` row, checks every `seq`
         up to the head has exactly one chain row (no gaps, no duplicates), and reports separately **unchained rows**
         (count and oldest age). Unchained is not a break; it is lag.
      6. **Lag is a safety signal.** Add `core_audit_chain_lag_seconds` and `core_audit_unchained_rows`; alert when
         lag exceeds a limit you choose (proposed 60 s warning, 300 s page) and treat a stalled sequencer as sev2.
      7. The sequencer must not lock `audit_logs` rows in a way that blocks writers, and must run on the primary.

      This also unblocks reading P6-R2 (repeatable read failed only because of the head row) and the spec 9.1
      latency targets in X-LOAD-1. It interacts with DB-1 (P9-D1): a sequencer role with insert rights on
      `audit_chain` only is the natural role to split out when the owner and application roles are separated.
      Tasks P9-A1 to P9-A9 below.

### Audit chain sequencer (from P9-D3)

Write the tests first: they pin what `verify` must keep proving. Do not weaken an existing audit or chain assertion;
`audit-logs.service.spec.ts` and `database-security.int-spec.ts` define today's guarantees.

- [ ] **P9-A1 TEST. Baseline and target.** Run `test/load/audit-chain.load-spec.ts` on the current design and record
      the numbers. Add the pass condition for the new design: audited writes per second no longer fall as trailing
      work per transaction rises (the 5 ms, 20 ms and 8, 32 worker matrix in `LOAD_RESULTS.md`).
- [ ] **P9-A2 BUILD. Migration.** Add `xid` (`xid8`, default `pg_current_xact_id()`) to `audit_logs`; create
      append-only `audit_chain(position, seq, created_at, prev_hash, hash)` with the same revokes and
      `reject_mutation` triggers as `audit_logs`; move `prev_hash` and `hash` off `audit_logs`. Decide whether the
      existing rows are backfilled into `audit_chain` by one migration step that recomputes nothing (copy the
      existing hashes, so history stays verifiable). **Back up first; this touches an append-only table.**
- [ ] **P9-A3 BUILD. Write path.** `src/common/audit/audit.repository.ts` stops reading and updating
      `audit_chain_head`. `AuditService.record(tx, ...)` still writes the row inside the caller's `UnitOfWork.run`,
      last. `audit_chain_head` is no longer touched by request code.
- [ ] **P9-A4 BUILD. Sequencer.** A processor registered in `src/jobs/jobs.module.ts` (or the consumer process),
      holding an advisory lock, selecting committed rows with the xid gate (see P9-D3 constraint 3) in batches,
      computing hashes with the existing pure `chainHash` in `src/common/audit/audit-chain.ts`, and inserting chain
      rows and the new head in one transaction. Idempotent: a crash and restart re-chains nothing twice. Define retry
      and failure behaviour (`AGENTS.md`: every new asynchronous process).
- [ ] **P9-A5 BUILD. Verify.** Rework `AuditLogsService.verify` and `AuditLogsRepository`: walk `audit_chain` by
      `position`, recompute each hash from its `audit_logs` row, check no `seq` gap or duplicate up to the head, and
      return unchained count and oldest age separately from breaks. Update the response schema and OpenAPI.
- [ ] **P9-A6 TEST. Correctness under concurrency.** Integration tests with real Postgres: a transaction that gets a
      low `seq` and commits after a higher one is still chained exactly once; a rolled-back transaction leaves no
      chain row and no gap that `verify` reports as a break; two sequencers never run at once; a crash between
      hashing and commit leaves the head consistent; tampering with an `audit_logs` row (as superuser) is reported at
      the right position; batches across a partition boundary.
- [ ] **P9-A7 BUILD. Metrics and alerts.** `core_audit_chain_lag_seconds`, `core_audit_unchained_rows`; add the
      alert rules to X-ALERT-1; add a runbook to `OPERATIONS.md` ("Audit chain lag") and a test in
      `runbooks.int-spec.ts`.
- [ ] **P9-A8 VERIFY. Re-measure** with P9-A1 and in X-LOAD-1 and X-LOAD-2 (soak: the wait on `audit_chain_head`
      must be gone from `pg_stat_statements`). Revisit P6-R2 (repeatable read for batch creation).
- [ ] **P9-A9 DOC. Record the departure.** Amend spec 5.2 (`audit_logs`, new `audit_chain`) and 6.14 in
      `CORE_API_BUILD_PROMPT.md`, add the decision to `ARCHITECTURE.md`, update `SECURITY.md` (close PERF-2),
      `DATABASE.md`, `PRODUCTION_READINESS.md` and `LOAD_RESULTS.md`.

- [ ] **P9-D4 DECIDE. Risk acceptance process.** Nothing can be "approved" until one exists. Define who accepts
      which severity, and record it in `PRODUCTION_READINESS.md`.

### Medium and low findings

- [ ] **P9-GW-1 BUILD.** `RedisCircuitBreaker` has no caller. Routing (P4-02) must skip a provider with an open
      breaker (spec 6.2).
- [ ] **P9-PERF-1 BUILD.** Load shedding (spec 9.2 rule 13: event-loop lag above 200 ms or deep queues).
- [x] **P9-PERF-3 BUILD.** An exhausted connection pool or overload answers `500 INTERNAL_ERROR`. Return `503` with
      `Retry-After`, with a catalogue code and a test.
      _Result:_ resolveError maps pool connect timeout, SQLSTATE 53300, 53400 and 57P03, PgBouncer client limit
      and statement timeout (also through drizzle causes, three levels) to 503 SERVICE_UNAVAILABLE with Retry-
      After 5. The existing catalogue code is used; no new code was needed. Tests: error-mapper.spec.ts and a new
      global-exception.filter.spec.ts.
- [x] **P9-RDY-1 BUILD.** Health or readiness endpoint for the worker and consumer; a `HEALTHCHECK` in the image.
      _Result:_ New HEALTH_PORT (default 4001). src/bootstrap/health-server.ts serves /health and /health/ready
      (database_rw and Redis) from the worker and consumer; src/scripts/healthcheck.ts and a Dockerfile
      HEALTHCHECK test liveness. Tests: health-server.spec.ts, healthcheck.spec.ts and test/chaos/process-
      health.chaos-spec.ts (4 passed against the built processes). The image itself was not rebuilt here, so run
      the Trivy and image build in CI.
- [x] **P9-GW-2 FIX.** A payout answered 401 or 403 is retried up to 8 times (same key, financially safe). Spec 3.5
      says page and do not loop. Stop retrying on 401/403 and raise an alert.
      _Result:_ SettlementGatewayAuthRejected (a SettlementSubmitRetry) is thrown on 401 and 403; the settlement-
      run processor turns it into an UnrecoverableError, so BullMQ does not retry it. An error is logged and
      core_gateway_auth_rejections_total rises. The sweep still re-drives the payout once per
      SETTLEMENT_RELEASE_RETRY_SECONDS with the same externalId; the hold stays. Tests: phase6-jobs.spec.ts and
      the 401, 403, 404 and 429 cases in settlement.int-spec.ts (which passed with aml-controls.int-spec.ts).
- [x] **P9-GW-3 FIX.** `GATEWAY_MAX_RETRIES` is validated and read by nothing. Implement it in the client (P3-02) or
      remove it (schema and `.env.example` together).
      _Result:_ Implemented in `GatewayOperationsClient.callWithRetry`; retries 429 and 5xx (except 504) up to the
      configured limit.
- [ ] **P9-OBS-1 BUILD.** Missing spec 10 metrics: `core_payment_initiations_total`, `core_ledger_entries_total` (add
      after commit, not inside a transaction), `core_merchant_available_balance_minor`,
      `core_gateway_request_duration_seconds`, `core_gateway_event_lag_seconds`,
      `core_gateway_events_processed_total` (the last three need the consumer).
- [x] **P9-SEC-LOG BUILD.** Log redaction matches key names, not values; a secret in free text is not scrubbed. Add
      value-pattern redaction for known secret formats (`sk_`, `mpsig_`, bearer tokens) and tests.
      _Result:_ src/common/logging/redaction.ts gains redactSecretText (mp_/sk_ secret keys, mpsig_, whsec_,
      Bearer credentials, JWTs, PEM private keys), applied to every string in redactDeep, to error messages and
      stacks, and to the pino message and its format arguments through hooks.logMethod. pk_ keys are identifiers
      and are left readable. Tests in redaction.spec.ts and logger.spec.ts.
- [ ] **P9-SEC-RLS DECIDE.** No row-level security (spec does not ask; isolation is `merchantId` in every repository
      method). Adding it is an architecture change. _Default:_ no.
- [ ] **P9-DEP-1 DOC.** Dev tooling has 29 moderate and 2 low vulnerabilities (not shipped; `npm audit` fixes are
      downgrades; not applied). Record the acceptance.
- [ ] **P9-DEP-2 DECIDE.** Major upgrades available, none security-driven: NestJS 12, BullMQ 6, ioredis 6, undici 8,
      cron-parser 5, bullmq-otel 2, TypeScript 7. Each needs its own change and a full regression run. Unpin
      `@fastify/cors` (pinned at 11.3.0, latest 11.4.3) or document why.
- [ ] **P9-PLAN-1 VERIFY.** Same as P2-03.
- [ ] **P9-PLAN-2 DECIDE.** `transactions_final_day_idx` (rollup recompute 460 ms to 15 ms) was not added (+20.8% WAL
      on the hottest table). Add it when one day's window passes about 5 million rows or the job nears the 15 s
      statement timeout. Add a metric or alert for that threshold.

### Not verified or not done

- [ ] **P9-V1** Point-in-time recovery from WAL (only a logical `pg_dump` restore was exercised).
- [ ] **P9-V2** Deploy, rollback and the large-table index procedure (`DEPLOYMENT.md`) rehearsed on staging.
- [ ] **P9-V3** Image scan (Trivy) runs in CI only; confirm it runs and gates.
- [ ] **P9-V4** PgBouncer transaction-mode behaviour with a PgBouncer in the tests.
- [ ] **P9-V5** VACUUM and bloat over days, replica lag, `pg_stat_statements` on a production-sized dataset.
- [ ] **P9-V6** Traces examined. **P9-V7** Penetration test. **P9-V8** Review of the customer module's encrypted PII
      columns.
- [ ] **P9-V9** Measure webhook delivery rate, gateway callback throughput, consumer throughput (above 500 events/s)
      and merchant payout load (after section 3).
- [ ] **P9-V10** Replace the starting-point resource limits in `DEPLOYMENT.md` with measured values.
- [ ] **P9-V11 `gateway:verify`** (spec section 13) is P3-12.
- [x] **P9-V12** A worker started without a gateway shows a failed gateway-gap reconciliation job every five minutes.
      Document it or require the gateway for worker start in production.
      _Result:_ Documented in DEPLOYMENT.md (Configuration). Production already refuses to boot without
      GATEWAY_BASE_URL, so the failing job occurs only outside production.
- [ ] **P9-V13 DECIDE. Retention periods not in the spec:** idempotency keys 7 days after expiry, published outbox
      rows 14 days. Confirm. Add the `gateway_events` 1-year policy row with the Phase 3 migration (P3-06).
- [x] **P9-V14 FIX. Outbox purge** is bounded by an id range that assumes UUID v7 time-ordered ids; if ids stop being
      time-ordered the purge deletes nothing. Add a guard test or a visible metric for rows older than retention that
      remain.
      _Result:_ Chose the guard test. src/common/outbox/outbox-id-order.spec.ts fails if an outbox id leaves the
      millisecond of created_at, or if a second insert path into core.outbox appears. A published-rows metric
      needs a published_at index or a scan of the table, so it was not added.
- [x] **P9-V15 DOC.** Regenerate `docs/query-plans/phase9.txt` (the script gained a `DROP INDEX IF EXISTS` guard).
      _Result:_ Regenerated against a fresh postgres:16 container with migrations 0000 to 0010 applied (11
      migrations, which also shows they apply to an empty database). Plan shapes match the previous file; only
      random ids and one planner choice (a status-prefixed transactions index) differ.
- [ ] **P9-V16** A person who did not write the review reads and signs `PRODUCTION_READINESS.md`.

---

## 9. Cross-cutting tasks

Each task lists the phases it closes items for.

### Load and soak (closes B-2, B-3)

- [ ] **X-LOAD-1 VERIFY. Spec 9.1 latency and throughput.** Run `npm run test:load` three times on quiet hardware
      (16 GB, 2 vCPU API) or in CI, after section 3. Known misses in the first, least affected run:
      `POST /v1/payments` excluding the gateway p99 283 ms against 80 ms (p50 12 ms); 6-line ledger posting p99
      55 ms against 25 ms (p50 7.4 ms). Profile before changing code. Do not relax a target or a financial rule. Also
      measure: read throughput above 1,200 req/s per 2 vCPU replica; the consumer above 500 events/s with the real
      consumer; settlement cycle and balance proof under many merchants (P6-R6); the AML post-transaction
      monitoring and counter rebuild (Phase 7); balances. Update `LOAD_RESULTS.md` by hand from three clean runs.
      Harness limits: one API process on loopback, Postgres and Redis on the same machine, one merchant, 200,000
      seeded transactions.
- [ ] **X-LOAD-2 VERIFY. 30-minute soak,** three times: `npm run build && SOAK_MINUTES=30 npm run test:soak`. Pass:
      no memory growth, no connection leak, no latency drift. Result files are git-ignored; record the numbers in
      `LOAD_RESULTS.md`.

### Real services (staging)

- [ ] **X-REAL-1** Run the Phase 6 gateway adapter and the Phase 3 client against the running gateway (P6-V2).
- [ ] **X-REAL-2** Real S3-compatible store: KYC documents and report multipart (P7-V1, P8-V2).
- [ ] **X-REAL-3** Real OpenSanctions (P7-V2).
- [ ] **X-REAL-4** Real email, SMS and push vendors (P8-V1).

### Migrations, workers, time

- [ ] **X-MIG-1 VERIFY.** Apply migrations 0006, 0007, 0008 (and 0009, 0010) to a populated database copy; measure lock
      time, especially the CHECK, trigger and foreign key on partitioned `core.transactions`.
- [ ] **X-WORKER-1 TEST.** One test or a staging check that runs a worker through the outbox, a queue and a job end to
      end (Phases 6, 7, 8).
- [ ] **X-TZ-1 TEST.** Time-zone behaviour in the zones you will use: settlement cycles (P6-V4), AML volume counters
      at a merchant's local midnight (P7-V7), rollups and SLA windows (P8-V8).

### Query plans and alerts

- [ ] **X-PLAN-1 DOC. Query plans** (`EXPLAIN (ANALYZE, BUFFERS)` into `docs/query-plans/`), spec section 16 and
      spec 9.2 rule 7:
  - Phase 6: period totals and transaction page, due-reserve lock, reconciliation queue, stale-transaction scan,
    statement candidates.
  - Phase 7: alert and case queues, KYC queue, monitoring window queries, `reversibleCollectionEntry`, counter
    rebuild.
  - Phase 8: complaint queues, delivery log, report cursor queries, rollup recompute and reads, stuck-transaction
    query, notification claim.
  - Phase 4: see P4-T5. Phase 9: regenerate `phase9.txt` (P9-V15).
- [ ] **X-ALERT-1 BUILD. Alert rules.** Metrics exist; no rules do. Write rules for: ledger integrity above 0,
      suspense balance, exceptions open too long, `releasing` batches past the retry window (Phase 6); AML alert SLA
      breaches, KYC decisions, screening failures (Phase 7); consumer lag, stuck transactions, queue-depth growth,
      webhook failure rate, replica lag (spec section 10), notification backlog, complaint SLA breaches (Phase 8).
      Keep them in the repository (for example `deploy/alerts/`) with a test that every referenced metric exists.
      _Result:_ Partly done, left open on purpose. deploy/alerts/core-api.rules.yml holds 17 rules for the metrics
      that exist (ledger integrity, suspense at 1 h and 24 h, gateway 401/403, stuck transactions, reconciliation
      run failures, outbox exhaustion, queue depth, webhook failure rate, notification backlog, partitions, no AML
      rule enabled, AML and complaint SLA breaches). src/common/telemetry/alert-rules.spec.ts fails if a rule
      names a missing metric or a missing runbook heading. Still without a rule because the metric does not exist:
      consumer lag, replica lag, age of open exceptions, batches stuck in releasing, screening failures, audit
      chain lag. The webhook and notification thresholds are proposals.

### Documentation

- [x] **X-DOC-1 DOC. Refresh the stale docs:** `ARCHITECTURE.md` is missing the "Phase 6 decisions to confirm"
      section that `AGENTS.md` and `RECONCILIATION.md` refer to; `API_PUBLIC.md` lists `settlements` as not built
      though it is built; `GATEWAY_INTEGRATION.md` still says "Phase 0"; the top of `phases_summary.md` is stale
      (see "How to use this file"). Update `AGENTS.md` "Current phase" when Phases 3 and 4 land.
      _Result:_ ARCHITECTURE.md gained 'Phase 6 decisions to confirm'; API_PUBLIC.md marks settlements built (read
      only); GATEWAY_INTEGRATION.md status line updated; phases_summary.md carries a stale-sections banner. The
      AGENTS.md 'Current phase' update waits for Phases 3 and 4.
- [x] **X-DOC-2 DOC.** README environment variable lists for Phases 7 and 8 (P7-08, P8-13).
      _Result:_ Done through P7-08 and P8-13.
- [ ] **X-DOC-3 DOC.** `LEDGER.md` (spec section 13): fee, refund, payout, settlement (P6-09) and dispute (P7-07)
      posting patterns.
- [ ] **X-OPENAPI-1 DOC.** Regenerate `docs/openapi/{public,dashboard,admin}.json` after every route change (section
      10); `api-contract.int-spec.ts` fails on drift.

### Tests that guard conventions

- [ ] **X-TEST-1** A test that every money-out route calls the payout-control checks (P7-01) and carries the
      idempotency interceptor (P4-08).
- [ ] **X-TEST-2** Keep `test/integration/ledger-schema.int-spec.ts` minor-unit inventory current for every new money
      column (P4-T4).

---

## 10. Environment and process notes

- **Docker:** `export DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock` and `TESTCONTAINERS_RYUK_DISABLED=true`
  before integration tests.
- **Parallelism:** on an 8 GB machine use `npx vitest run --maxWorkers=2` or `3`, or `--maxWorkers=1` for the full
  coverage run (`npx vitest run --coverage --maxWorkers=1`). Timeouts at the default count are load failures, not
  logic failures, but confirm by rerunning alone before dismissing one.
- **Long runs:** start with `nohup` and poll a `.done` file; foreground commands stall while the machine swaps.
- **OpenAPI regeneration:** `OPENAPI_UPDATE=1 npx vitest run --project integration test/integration/api-contract.int-spec.ts`.
  `npm run openapi:export` fails without environment variables.
- **Migrations:** `npm run db:generate` then `npm run db:migrate`. Never `drizzle-kit migrate` or `push`.
- **Test isolation:** shared Postgres and Redis. Do not reuse currency and provider pairs reserved by earlier suites
  (airtel/TZS, flutterwave/GHS, test/MWK, XAF for AML, XOF for disputes). Do not rely on the `viewer` role in new
  tests; restore any role, rule or limit a test edits.
- **Config:** new variables go in `src/config/env.schema.ts` and `.env.example` together. New error codes go in
  `src/common/errors/catalogue.ts` in the phase that needs them.
- **`WEBHOOK_ALLOW_PRIVATE_NETWORKS`** is `true` in the test environment only; production refuses it.

---

## 11. Final exit gate

Run after all sections are complete, on quiet hardware or in CI. Every line must hold.

- [ ] `npm ci` on a clean checkout succeeds.
- [ ] `npm run typecheck`, `npm run lint` (`--max-warnings 0`) and `npm run format:check` pass with zero warnings.
- [ ] `npx vitest run --coverage --maxWorkers=1` passes; 80% overall; 100% on `src/modules/{ledger,balances,holds}` and
      `src/common/money`.
- [ ] `npm run build && npm run test:chaos` passes, including scenarios A and G (P3-15, P9-04).
- [ ] Migrations apply to an empty database and to a populated copy (X-MIG-1).
- [ ] `npm run test:load` meets every spec 9.1 target in three clean runs (X-LOAD-1).
- [ ] The 30-minute soak passes three times (X-LOAD-2).
- [ ] `docs/openapi/*.json` match the code (`api-contract.int-spec.ts` passes).
- [ ] A payment, a refund and a payout each run end to end against the real gateway in staging and land correctly in
      the ledger; reconciliation shows no unexplained difference.
- [ ] Every DECIDE task above is answered and recorded in `ARCHITECTURE.md` (the "decisions to confirm" sections), and
      no architectural conflict is open (P6-D1 and P9-D1 are the known candidates; P5-D9 and P9-D3 are decided and need their spec amendments, P5-K6 and P9-A9).
- [ ] A person who did not write the code has read and signed `PRODUCTION_READINESS.md` (P9-V16), and compliance has
      closed P7-C1 to P7-C3.
