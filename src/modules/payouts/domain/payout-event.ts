/**
 * Payout event structure: lifecycle signals from gateway, chase job, expiry sweep, or cancel route.
 *
 * Mirrors payment-event.ts but for disbursement operations.
 */
import type { PaymentProvider } from '../../payments/domain/payment-event';
import type { PayoutStatus } from './payout-state-machine';

export type PayoutEventSource = 'gateway' | 'api' | 'chase' | 'expiry' | 'manual';

export type PayoutSignal =
  | { readonly kind: 'created' }
  | { readonly kind: 'pending_approval' }
  | { readonly kind: 'processing'; readonly outcomeUnknown?: boolean }
  | {
      readonly kind: 'succeeded';
      readonly feeMinor?: bigint;
      readonly providerFeeMinor?: bigint;
    }
  | { readonly kind: 'failed'; readonly code?: string }
  | { readonly kind: 'expired'; readonly code?: string }
  | { readonly kind: 'cancelled'; readonly code?: string };

export interface PayoutGatewayDetails {
  readonly provider?: PaymentProvider;
  readonly operationId?: string;
  readonly referenceId?: string;
  readonly providerTransactionId?: string;
  readonly amountMinor?: bigint;
  readonly currency?: string;
}

export interface PayoutEventInput {
  /** Unique per event (idempotency). Gateway sends `{providerId}:{referenceId}:{status}`. */
  readonly eventKey: string;
  readonly source: PayoutEventSource;
  readonly signal: PayoutSignal;
  /** When the event occurred (gateway `updatedAt` or now for local events). */
  readonly occurredAt: Date;
  /** Gateway operation details (only for gateway events). */
  readonly gatewayDetails?: PayoutGatewayDetails;
}

export function signalTarget(signal: PayoutSignal): PayoutStatus {
  return signal.kind as PayoutStatus;
}

/**
 * Basic validation: eventKey must be present, signal must be known.
 */
export function validatePayoutEvent(event: PayoutEventInput): void {
  if (!event.eventKey || event.eventKey.length === 0) {
    throw new Error('eventKey required');
  }
  if (!event.signal || !event.signal.kind) {
    throw new Error('signal.kind required');
  }
}

export function isPayoutProvider(provider: string | null): provider is PaymentProvider {
  const PROVIDERS = ['mtn_momo_ug', 'airtel_ug'];
  return provider !== null && PROVIDERS.includes(provider);
}
