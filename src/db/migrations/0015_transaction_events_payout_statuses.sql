-- Phase 4: extend transaction_events constraints to cover payout and refund statuses
-- and gateway_event source values used by disbursement and refund event handlers.

-- Drop the payment-only status check and replace with one covering all transaction types.
ALTER TABLE "core"."transaction_events"
  DROP CONSTRAINT IF EXISTS "transaction_events_status_check";

ALTER TABLE "core"."transaction_events"
  ADD CONSTRAINT "transaction_events_status_check" CHECK (
    (
      "from_status" IS NULL OR
      "from_status" IN (
        'created', 'requires_action', 'processing',
        'succeeded', 'failed', 'cancelled', 'expired',
        'pending_approval'
      )
    ) AND
    "to_status" IN (
      'created', 'requires_action', 'processing',
      'succeeded', 'failed', 'cancelled', 'expired',
      'pending_approval'
    )
  );
