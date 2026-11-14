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
