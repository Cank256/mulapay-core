# Gateway integration

Status: Phase 0. Core's only gateway call so far is the readiness probe
(`GET /api/v1/health/ready`, unauthenticated) in
`src/integrations/gateway/gateway-health.client.ts`. The client, event consumer and
failure handling arrive in Phase 3 and will be documented here.

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
