# Gateway integration

Status: Phases 0 to 2 and 5 to 9 are built; Phases 3 and 4 are not. Core's gateway calls today are the
readiness probe (`GET /api/v1/health/ready`, unauthenticated) in
`src/integrations/gateway/gateway-health.client.ts` and the settlement and reconciliation
operations client behind `GatewayOperationsPort` (`gateway-operations.client.ts`). The payment
client, event consumer and their failure handling arrive in Phase 3 and will be documented here.

Sources: spec section 3 and `provider_gateway/docs/CORE_API_INTEGRATION.md`.

## Differences between the spec and the gateway

Spec section 17 rule 3: for gateway behaviour, the gateway code wins, and conflicts are
recorded here.

| Topic                  | Spec says                                                       | Gateway says                                                                                                                                                                                      | Status                                           |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| MTN currencies         | UGX, GHS, XOF, XAF, ZMW (3.3)                                   | `config/provider-registry.ts` agrees with the spec; `utils/provider-validation.ts`, which rejects requests, allows UGX, EUR, GHS, ZMW, XOF, XAF (no conflict on what core sends, but EUR differs) | Resolve before Phase 3                           |
| Airtel currencies      | UGX, KES, TZS, RWF, ZMW, MWK, NGN                               | Registry agrees; validator allows UGX, KES, TZS, RWF, ZMW, NGN, XOF, XAF, so **MWK is rejected**                                                                                                  | Resolve before Phase 3                           |
| Flutterwave currencies | NGN, GHS, KES, UGX, TZS, ZAR, RWF, ZMW, XOF, XAF, USD, EUR, GBP | Validator allows NGN, GHS, KES, UGX, ZAR, TZS, USD, EUR, GBP, so **RWF, ZMW, XOF and XAF are rejected**                                                                                           | Resolve before Phase 3                           |
| Error envelope         | `requestId` inside `error`, plus `docUrl` (8.1)                 | `requestId` and `timestamp` in `meta`                                                                                                                                                             | Core follows the spec; envelopes differ slightly |

## Applying gateway events to payments (built ahead of Phase 3)

The payment domain does not call the gateway and does not know its wire format. What the
consumer and the chase job will call is `PaymentLifecycleService.apply(tx, paymentId,
event, options?)` (`src/modules/payments/payment-lifecycle.service.ts`), inside the
consumer's own transaction (spec 8.7). The consumer maps a gateway event to a `PaymentSignal`
(spec 3.7):

| Gateway status          | Signal                                          | Core status                        |
| ----------------------- | ----------------------------------------------- | ---------------------------------- |
| `pending`               | `{ kind: 'processing', outcomeUnknown: false }` | `processing`                       |
| `unknown`, 504, timeout | `{ kind: 'processing', outcomeUnknown: true }`  | `processing`, flag set, no posting |
| `successful`            | `{ kind: 'succeeded', amountMinor, currency }`  | `succeeded` and the ledger entry   |
| `failed`                | `{ kind: 'failed', failureCode }`               | `failed`                           |
| `expired`               | `{ kind: 'expired' }`                           | `expired`                          |
| `cancelled`             | `{ kind: 'cancelled' }`                         | `cancelled`                        |

Contract for the caller:

- `eventKey` is the gateway `event_id` (at most 96 characters). The same key applied twice
  returns `duplicate` and changes nothing.
- `identifiers` carries `provider`, `operationId`, `referenceId`, `providerTransactionId`.
  Each is set once; a different value later is refused as `identifier_conflict`.
- A success must carry the provider (in `identifiers` or already recorded), and should carry
  the amount and currency the gateway reports: a mismatch is refused, not posted.
- The result is a value, not an exception: `applied`, `updated`, `noop`, `duplicate`,
  `rejected` or `skipped`. A `rejected` event (terminal state, illegal transition, amount,
  currency, provider or identifier mismatch) is already recorded in `transaction_events` with
  its reason; the consumer commits its cursor and the reconciliation phase raises the
  exception (spec 3.7). Exceptions are for faults (ledger refused the posting): the whole
  transaction rolls back, including the status change, and the event is retried.
- After commit, call `observePaymentEvent(result, source)` for the metrics.
- `externalId` for the collection is the payment ref (`pay_...`), already stored in
  `transactions.gateway_external_id`; the registry makes it unique.
- Not yet possible to express: the gateway's `cancelled` or `expired` for a payment in
  `requires_action`, and `cancelled` for one in `processing`. They are refused as
  `invalid_transition` until the state machine is confirmed (docs/ARCHITECTURE.md).

## Test keys and the sandbox (Phase 5)

Test-environment operations never reach the gateway (spec 6.11, decision D4). The gateway client
must call `assertGatewayEligible(environment)` (`src/modules/developer/sandbox/domain/gateway-boundary.ts`)
before any request, which throws for `test`. Test payments are resolved by the sandbox simulator,
which drives `PaymentLifecycleService.apply` exactly as the event consumer will, with source `job`,
event keys `sandbox:{step}`, failure codes beginning `sandbox_`, and the provider `mtn` unless the
merchant pinned one. The simulator runs as `sandbox.step` jobs on the `gateway-chase` queue: when
the Phase 4 chase job arrives it must route by job name in the same processor
(`SandboxProcessor`), because each processor starts a worker on the whole queue.
`src/modules/developer/sandbox/sandbox-boundary.spec.ts` fails if the sandbox or the payment code
imports `integrations/gateway`.

## Failure behaviour (Phase 9 review)

What exists is the settlement payout client (`GatewayOperationsClient`) and the circuit breaker. The event
consumer, the collection and refund calls and the chase job are Phases 3 and 4 and are not built. What is
below is verified for what exists (`test/integration/gateway-failure.int-spec.ts`, 36 tests;
`test/chaos/gateway-queues.chaos-spec.ts`).

**The rule: a failure to get an answer is never an answer.**

| What happens                                      | Result for a disbursement                 | Result for a lookup, list or balance |
| ------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| 201 / 200 (duplicate)                             | `accepted` / `accepted, duplicate`        | operation found                      |
| 504, 500, 502, 503                                | `ambiguous` (identifiers kept if present) | `unavailable`                        |
| Timeout (no answer within `GATEWAY_TIMEOUT_MS`)   | `ambiguous`, one request sent             | `unavailable`                        |
| Connection dropped, body cut off, not JSON, empty | `ambiguous`                               | `unavailable`                        |
| 201 with no reference, or an unknown status       | `ambiguous`                               | `unavailable`                        |
| A slow answer inside the timeout                  | `accepted`                                | found                                |
| 400, 409                                          | `rejected` (provably created nothing)     | n/a                                  |
| 401, 403, 404                                     | `rejected`                                | `unavailable`                        |
| 429                                               | `rate_limited`                            | `unavailable`                        |
| 404 on a by-external-id lookup only               | n/a                                       | `not_found`                          |

An ambiguous payout stays `processing`, flagged `outcome_unknown`; the hold stays; nothing is posted; the
sweep and `verifyPayout` ask the gateway by the **same** `externalId` and apply only a terminal answer. A retry
carries the same `externalId` and amount; there is exactly one request per call; test-environment operations
never reach the gateway.

**One minute of 504** (chaos C, real time): the disbursement and every lookup answer 504. For 60 s the sweep
and verification run every 5 s: every check answers `unavailable`, the payout stays `processing` and unknown, the
hold stays active, the merchant's available balance does not move, **one** request ever reaches the gateway, and
no ledger entry exists. The stuck-transaction monitor opens an incident (`ops:stuck_transactions`). When the
gateway returns and says `successful`, `verifyPayout` applies it once: the batch is `paid`, two settlement entries
exist, the hold is captured, still one gateway request, and a second verification or sweep changes nothing. A
gateway that says `failed` after a 504 releases the hold and posts nothing.

**Circuit breaker** (`RedisCircuitBreaker`, spec 6.2). Tested for the first time in Phase 9 (it had no tests):
closed below 5 consecutive failures; failures more than 30 s apart do not accumulate; opens on the fifth; refuses
calls; half-opens after exactly `GATEWAY_CIRCUIT_RESET_MS` (15 s); closes after 3 successful probes; a failed probe
reopens for a full period; state is shared by every replica through Redis (concurrent updates are all counted);
independent per (provider, operation); and **fails open** when Redis is unreachable.
**Open finding GW-1: nothing calls it.** Spec 6.2's routing ("a route is skipped when its breaker is open")
belongs to Phase 4. Until then the breaker protects nothing, and settlement payouts go to the gateway directly.

A payout answered 401 or 403 (GW-2, closed) fails its queue job at once and is not retried in a loop, as spec 3.5
asks: it logs an error and raises `core_gateway_auth_rejections_total`; the sweep re-sends it with the same key once
per `SETTLEMENT_RELEASE_RETRY_SECONDS` after the credentials are fixed.
Difference from spec 3.5 found in review, not financially unsafe, recorded in `SECURITY.md`: GW-3 (`GATEWAY_MAX_RETRIES` is validated and unused: the client makes one attempt and the caller retries with the
same key, which is the safe design, so the setting should be removed or implemented).
