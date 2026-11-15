/**
 * Test keys never reach the gateway (spec 6.11, decision D4). The gateway client (Phase 3)
 * and every code path that submits an operation to it must call `assertGatewayEligible`
 * with the operation's environment first; a test-environment operation is a programming
 * error, so it throws instead of returning a result someone might ignore.
 *
 * `sandbox-boundary.spec.ts` complements this by asserting that nothing in the sandbox
 * imports the gateway integration.
 */
export function assertGatewayEligible(environment: 'test' | 'live'): void {
  if (environment !== 'live') {
    throw new Error('test-environment operations must never be sent to the gateway');
  }
}
