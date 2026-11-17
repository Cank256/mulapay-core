/**
 * Stub circuit breaker implementation (spec 6.2).
 *
 * Always returns "closed" (breaker is not open). The real implementation will use Redis
 * to track failure rates and open/close the breaker. This stub allows the routing service
 * to be built and tested before the full circuit breaker is implemented.
 */
import { Injectable } from '@nestjs/common';
import type { PaymentProvider } from '../../../payments/domain/payment-event';
import type { ProviderOperation } from '../../../../integrations/gateway/provider-capabilities';
import type { CircuitBreakerPort } from './circuit-breaker.port';

@Injectable()
export class CircuitBreakerStub implements CircuitBreakerPort {
  async isOpen(_provider: PaymentProvider, _operation: ProviderOperation): Promise<boolean> {
    // Always closed for now
    return false;
  }

  async recordSuccess(
    _provider: PaymentProvider,
    _operation: ProviderOperation
  ): Promise<void> {
    // No-op
  }

  async recordFailure(
    _provider: PaymentProvider,
    _operation: ProviderOperation
  ): Promise<void> {
    // No-op
  }

  async recordAmbiguous(
    _provider: PaymentProvider,
    _operation: ProviderOperation
  ): Promise<void> {
    // No-op
  }
}
