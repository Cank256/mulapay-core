/**
 * Circuit breaker port for provider availability (spec 6.2).
 *
 * Per (provider, operation): opens after 5 consecutive ambiguous or 5xx outcomes in 30
 * seconds, half-open after 15 seconds, closed after 3 successes. State lives in Redis so
 * all API replicas share it.
 *
 * The implementation is in the gateway integration module (Phase 4 will build it), but
 * the routing service only needs to know whether a breaker is open.
 */
import type { PaymentProvider } from '../../../payments/domain/payment-event';
import type { ProviderOperation } from '../../../../integrations/gateway/provider-capabilities';

export const CIRCUIT_BREAKER = Symbol('CIRCUIT_BREAKER');

export interface CircuitBreakerPort {
  /**
   * Returns true if the circuit breaker is open (provider should not be used).
   * Returns false if closed or half-open (provider can be tried).
   */
  isOpen(provider: PaymentProvider, operation: ProviderOperation): Promise<boolean>;

  /**
   * Record a successful provider operation.
   */
  recordSuccess(provider: PaymentProvider, operation: ProviderOperation): Promise<void>;

  /**
   * Record a failed provider operation.
   */
  recordFailure(provider: PaymentProvider, operation: ProviderOperation): Promise<void>;

  /**
   * Record an ambiguous provider outcome (504, timeout, 'unknown' status).
   */
  recordAmbiguous(provider: PaymentProvider, operation: ProviderOperation): Promise<void>;
}
