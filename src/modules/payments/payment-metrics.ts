/**
 * Metrics for payment events (spec section 10). Called after the transaction that applied
 * the event has committed, so a rolled-back attempt is never counted. The consumer and the
 * jobs call it too.
 */
import {
  transactionEventRejections,
  transactionStateTransitions,
} from '../../common/telemetry/metrics';
import type { PaymentEventSource } from './domain/payment-event';
import type { PaymentEventResult } from './payment-lifecycle.service';

export function observePaymentEvent(result: PaymentEventResult, source: PaymentEventSource): void {
  if (result.result === 'applied') {
    transactionStateTransitions.inc({ type: 'payment', from: result.from, to: result.to, source });
  } else if (result.result === 'rejected') {
    transactionEventRejections.inc({ type: 'payment', reason: result.reason, source });
  }
}
