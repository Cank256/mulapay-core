/**
 * What a gateway outcome does to a settlement batch and its payout (spec 3.7, 5.5, 17.5).
 * Pure.
 *
 *   success  -> capture the hold, post the settlement entries, batch `paid`
 *   failure  -> release the hold, no posting, batch `failed` (failed, expired or cancelled)
 *   unknown  -> nothing posts and nothing is released; the batch stays `releasing`
 *
 * Terminal states are final. An outcome that contradicts one (a success after the batch
 * failed, a failure after it was paid) changes nothing and is raised as a reconciliation
 * exception: money may have moved at the provider while the ledger says it did not.
 */
import type { BatchStatus } from './batch-state';

export type PayoutStatus = 'created' | 'processing' | 'succeeded' | 'failed';

export type PayoutSignal =
  | {
      readonly kind: 'processing';
      readonly outcomeUnknown: boolean;
      readonly referenceId?: string;
      readonly operationId?: string;
    }
  | {
      readonly kind: 'succeeded';
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly referenceId?: string;
      readonly operationId?: string;
      readonly providerTransactionId?: string;
    }
  | {
      readonly kind: 'failed' | 'expired' | 'cancelled';
      readonly failureCode?: string;
      readonly referenceId?: string;
      readonly operationId?: string;
    };

export type PayoutDecision =
  | { readonly action: 'record_processing' }
  | { readonly action: 'apply_success' }
  | { readonly action: 'apply_failure' }
  | { readonly action: 'noop'; readonly reason: string }
  | { readonly action: 'reject'; readonly reason: string };

export function decidePayoutOutcome(
  batch: BatchStatus,
  payout: PayoutStatus,
  signal: PayoutSignal
): PayoutDecision {
  const failed =
    signal.kind === 'failed' || signal.kind === 'expired' || signal.kind === 'cancelled';
  switch (batch) {
    case 'releasing': {
      if (payout === 'succeeded' || payout === 'failed') {
        return { action: 'reject', reason: 'payout_already_terminal' };
      }
      if (signal.kind === 'succeeded') return { action: 'apply_success' };
      if (failed) return { action: 'apply_failure' };
      return { action: 'record_processing' };
    }
    case 'paid':
      if (signal.kind === 'succeeded') return { action: 'noop', reason: 'already_paid' };
      if (failed) return { action: 'reject', reason: 'failure_after_paid' };
      return { action: 'noop', reason: 'already_paid' };
    case 'failed':
      if (failed) return { action: 'noop', reason: 'already_failed' };
      if (signal.kind === 'succeeded') return { action: 'reject', reason: 'success_after_failed' };
      return { action: 'noop', reason: 'already_failed' };
    default:
      return { action: 'reject', reason: 'batch_not_releasing' };
  }
}
