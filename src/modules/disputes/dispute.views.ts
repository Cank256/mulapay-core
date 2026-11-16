/**
 * What a dispute looks like on the API and in merchant events (spec 7.1, 7.2, 7.3). Amounts
 * are strings of minor units. The merchant sees the dispute and its own evidence; staff also
 * see the hold, the shortfall, the ledger entry and the internal note.
 */
import { z } from 'zod';
import type { DisputeRow, DisputeWithRefs } from './disputes.repository';

const iso = z.string();
const minor = z.string().regex(/^\d+$/);

export const merchantDisputeSchema = z.object({
  id: z.string(),
  transaction: z.string(),
  kind: z.enum(['chargeback', 'inquiry', 'pre_arbitration']),
  amountMinor: minor,
  currency: z.string(),
  reasonCode: z.string(),
  status: z.enum(['open', 'under_review', 'resolved']),
  outcome: z.enum(['merchant_won', 'merchant_lost', 'withdrawn']).nullable(),
  evidenceDueAt: iso.nullable(),
  evidence: z.array(z.object({ at: iso, text: z.string() })),
  createdAt: iso,
  resolvedAt: iso.nullable(),
});
export type MerchantDisputeView = z.infer<typeof merchantDisputeSchema>;

export const adminDisputeSchema = merchantDisputeSchema.extend({
  merchant: z.string(),
  heldMinor: minor,
  shortfallMinor: minor,
  resolutionEntry: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  internalNote: z.string().nullable(),
});
export type AdminDisputeView = z.infer<typeof adminDisputeSchema>;

export const merchantDisputePageSchema = z.object({
  items: z.array(merchantDisputeSchema),
  nextCursor: z.string().nullable(),
});
export const adminDisputePageSchema = z.object({
  items: z.array(adminDisputeSchema),
  nextCursor: z.string().nullable(),
});

export function toMerchantDispute(found: DisputeWithRefs): MerchantDisputeView {
  const { row } = found;
  return {
    id: row.ref,
    transaction: found.transactionRef,
    kind: row.kind as MerchantDisputeView['kind'],
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    reasonCode: row.reasonCode,
    status: row.status as MerchantDisputeView['status'],
    outcome: row.outcome as MerchantDisputeView['outcome'],
    evidenceDueAt: row.evidenceDueAt?.toISOString() ?? null,
    evidence: row.evidence,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export function toAdminDispute(found: DisputeWithRefs): AdminDisputeView {
  const { row } = found;
  return {
    ...toMerchantDispute(found),
    merchant: found.merchantRef,
    heldMinor: row.holdMinor.toString(),
    shortfallMinor: row.shortfallMinor.toString(),
    resolutionEntry: row.resolutionEntryRef,
    resolutionNote: row.resolutionNote,
    internalNote: row.internalNote,
  };
}

/** The payload of `dispute.created` and `dispute.resolved`: the merchant's view, as at that moment. */
export function toDisputeEvent(
  row: DisputeRow,
  transactionRef: string | null
): Record<string, unknown> {
  return {
    id: row.ref,
    transaction: transactionRef,
    kind: row.kind,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    reasonCode: row.reasonCode,
    status: row.status,
    outcome: row.outcome,
    evidenceDueAt: row.evidenceDueAt?.toISOString() ?? null,
  };
}
