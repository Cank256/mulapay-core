/**
 * What can happen to a payment after it exists, expressed in core's own terms.
 *
 * The gateway event consumer (Phase 3) and the chase job (Phase 4) translate gateway
 * statuses into these signals (spec 3.7): `pending` is `processing`, `unknown` is
 * `processing` with `outcomeUnknown`, `successful` is `succeeded`, and so on. Nothing in
 * this module knows the gateway's wire format, so core is not coupled to it.
 *
 * Pure: no I/O.
 */
import { AppError } from '../../../common/errors/app-error';
import { isSupportedCurrency } from '../../../common/money/currency-codes';
import { isPositiveMinor } from '../../../common/money/minor-units';
import type { PaymentStatus } from './payment-state-machine';

export const PAYMENT_PROVIDERS = ['mtn', 'airtel', 'flutterwave'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export function isPaymentProvider(value: string): value is PaymentProvider {
  return (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

/** Where an event came from. Stored with the transaction event and used as a metric label. */
export const EVENT_SOURCES = ['api', 'job', 'gateway_event', 'chase'] as const;
export type PaymentEventSource = (typeof EVENT_SOURCES)[number];

export type PaymentSignal =
  | { readonly kind: 'requires_action' }
  /**
   * The provider has the operation. `outcomeUnknown` is true when the gateway could not say
   * what happened (a 504, a timeout, an `unknown` status): the payment stays `processing`
   * and nothing is posted (spec 3.5, 3.7).
   */
  | { readonly kind: 'processing'; readonly outcomeUnknown: boolean }
  | {
      readonly kind: 'succeeded';
      /** What the provider says it collected. When present it must equal the payment. */
      readonly amountMinor?: bigint;
      readonly currency?: string;
      /** MulaPay fee and provider fee, from the fee engine. Zero until that exists. */
      readonly feeMinor?: bigint;
      readonly providerFeeMinor?: bigint;
    }
  | { readonly kind: 'failed'; readonly failureCode: string; readonly failureReason?: string }
  | { readonly kind: 'cancelled'; readonly failureCode?: string; readonly failureReason?: string }
  | { readonly kind: 'expired'; readonly failureCode?: string; readonly failureReason?: string };

export type PaymentSignalKind = PaymentSignal['kind'];

/** Identifiers the gateway reports. Each is set once and must never change (spec 3.4). */
export interface GatewayIdentifiers {
  readonly provider?: PaymentProvider;
  readonly operationId?: string;
  readonly referenceId?: string;
  readonly providerTransactionId?: string;
}

export interface PaymentEventInput {
  /**
   * Deduplication key: the gateway `event_id`, a chase attempt id, or a deterministic
   * business key (`api:cancel`, `job:expiry`). Never a timestamp or a random value
   * (spec 8.2). The same key applied twice changes nothing.
   */
  readonly eventKey: string;
  readonly source: PaymentEventSource;
  /** When the source says it happened. */
  readonly occurredAt: Date;
  readonly signal: PaymentSignal;
  readonly identifiers?: GatewayIdentifiers;
}

/** The payment status a signal asks for. */
export function signalTarget(signal: PaymentSignal): PaymentStatus {
  return signal.kind;
}

/** At most 96 so `{paymentRef}:{eventKey}` fits the ledger's 128-character source id. */
const EVENT_KEY = /^[A-Za-z0-9._:@-]{1,96}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE_REASON_MAX = 500;
const IDENTIFIER = /^[A-Za-z0-9._:@-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(reason: string): AppError {
  return new AppError('PAYMENT_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

function checkFailure(code: string | undefined, reason: string | undefined): void {
  if (code !== undefined && !FAILURE_CODE.test(code)) throw invalid('failure_code');
  if (reason !== undefined) {
    if (code === undefined) throw invalid('failure_reason_without_code');
    if (reason.length < 1 || reason.length > FAILURE_REASON_MAX) throw invalid('failure_reason');
  }
}

/**
 * Checks an event before it touches the database. The callers are internal (the consumer,
 * jobs, application services), so a failure is a programming error and is thrown, not
 * recorded as a refused event.
 */
export function validatePaymentEvent(event: PaymentEventInput): void {
  if (!EVENT_KEY.test(event.eventKey)) throw invalid('event_key');
  if (!(EVENT_SOURCES as readonly string[]).includes(event.source)) throw invalid('source');
  if (Number.isNaN(event.occurredAt.getTime())) throw invalid('occurred_at');
  const ids = event.identifiers;
  if (ids) {
    if (ids.provider !== undefined && !isPaymentProvider(ids.provider)) throw invalid('provider');
    if (ids.operationId !== undefined && !UUID.test(ids.operationId)) throw invalid('operation_id');
    if (ids.referenceId !== undefined && !IDENTIFIER.test(ids.referenceId)) {
      throw invalid('reference_id');
    }
    if (ids.providerTransactionId !== undefined && !IDENTIFIER.test(ids.providerTransactionId)) {
      throw invalid('provider_transaction_id');
    }
  }
  const signal = event.signal;
  switch (signal.kind) {
    case 'requires_action':
    case 'processing':
      return;
    case 'failed':
      checkFailure(signal.failureCode, signal.failureReason);
      return;
    case 'cancelled':
    case 'expired':
      checkFailure(signal.failureCode, signal.failureReason);
      return;
    case 'succeeded': {
      if (signal.amountMinor !== undefined && !isPositiveMinor(signal.amountMinor)) {
        throw invalid('amount');
      }
      if (signal.currency !== undefined && !isSupportedCurrency(signal.currency)) {
        throw invalid('currency');
      }
      for (const fee of [signal.feeMinor, signal.providerFeeMinor]) {
        if (fee !== undefined && (typeof fee !== 'bigint' || fee < 0n)) throw invalid('fee');
      }
      return;
    }
  }
}
