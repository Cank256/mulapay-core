/** Merchant-facing balance movement (spec 7.1 `GET /v1/balance-transactions`). */
import { z } from 'zod';
import type { MovementRow } from '../../modules/ledger/ledger-query.repository';

export const balanceTransactionSchema = z.object({
  id: z.string(),
  /** The journal entry that made the movement. */
  entryId: z.string(),
  kind: z.string(),
  /** The payment, refund or payout the movement belongs to. */
  reference: z.string(),
  /** `credit` raises the merchant's balance, `debit` lowers it. */
  direction: z.enum(['credit', 'debit']),
  amountMinor: z.string(),
  currency: z.string(),
  createdAt: z.iso.datetime(),
});
export type BalanceTransactionView = z.infer<typeof balanceTransactionSchema>;

export const balanceTransactionPageSchema = z.object({
  items: z.array(balanceTransactionSchema),
  nextCursor: z.string().nullable(),
});

/** The source id is `{ref}` or `{ref}:{event key}`; only the ref belongs to the merchant. */
export function toBalanceTransactionView(row: MovementRow): BalanceTransactionView {
  return {
    id: row.movement_key,
    entryId: row.entry_ref,
    kind: row.kind,
    reference: row.source_id.split(':')[0] ?? row.source_id,
    direction: row.direction as BalanceTransactionView['direction'],
    amountMinor: row.amount_minor,
    currency: row.currency,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
