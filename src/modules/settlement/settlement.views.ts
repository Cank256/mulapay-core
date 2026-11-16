/**
 * What settlements look like on the API (spec 7.1 `/v1/settlements`, 7.3 admin). Amounts are
 * strings of minor units. Internal ids, destination details and gateway identifiers never
 * appear; the merchant sees a masked destination and the payout's own reference.
 */
import { z } from 'zod';
import type { BatchRow, ItemRow } from './settlement-batches.repository';
import type { CycleRow } from './settlement-cycles.repository';

const minor = z.string().regex(/^\d+$/);
const iso = z.string();

export const settlementSchema = z.object({
  id: z.string(),
  status: z.enum([
    'draft',
    'pending_approval',
    'approved',
    'releasing',
    'paid',
    'failed',
    'cancelled',
  ]),
  currency: z.string(),
  periodStart: iso,
  periodEnd: iso,
  grossMinor: minor,
  refundMinor: minor,
  feeMinor: minor,
  reserveWithheldMinor: minor,
  reserveReleasedMinor: minor,
  disputeHoldMinor: minor,
  amlHoldMinor: minor,
  shortfallMinor: minor,
  netMinor: minor,
  payoutTransaction: z.string().nullable(),
  releasedAt: iso.nullable(),
  paidAt: iso.nullable(),
  createdAt: iso,
});
export type SettlementView = z.infer<typeof settlementSchema>;

export const settlementItemSchema = z.object({
  kind: z.enum([
    'payment',
    'refund',
    'reserve_withheld',
    'reserve_released',
    'dispute_hold',
    'aml_hold',
  ]),
  transaction: z.string().nullable(),
  amountMinor: minor,
  feeMinor: minor,
  netMinor: minor,
  occurredAt: iso.nullable(),
});
export type SettlementItemView = z.infer<typeof settlementItemSchema>;

export const settlementPageSchema = z.object({
  items: z.array(settlementSchema),
  nextCursor: z.string().nullable(),
});
export const settlementItemPageSchema = z.object({
  items: z.array(settlementItemSchema),
  nextCursor: z.string().nullable(),
});

export function toSettlementView(
  row: BatchRow,
  payoutTransactionRef: string | null = null
): SettlementView {
  return {
    id: row.ref,
    status: row.status as SettlementView['status'],
    currency: row.currency,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    grossMinor: row.grossMinor.toString(),
    refundMinor: row.refundMinor.toString(),
    feeMinor: row.feeMinor.toString(),
    reserveWithheldMinor: row.reserveMinor.toString(),
    reserveReleasedMinor: row.reserveReleaseMinor.toString(),
    disputeHoldMinor: row.disputeHoldMinor.toString(),
    amlHoldMinor: row.amlHoldMinor.toString(),
    shortfallMinor: row.shortfallMinor.toString(),
    netMinor: row.netMinor.toString(),
    payoutTransaction: payoutTransactionRef,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSettlementItemView(row: ItemRow): SettlementItemView {
  return {
    kind: row.kind as SettlementItemView['kind'],
    transaction: row.transactionRef,
    amountMinor: row.amountMinor.toString(),
    feeMinor: row.feeMinor.toString(),
    netMinor: row.netMinor.toString(),
    occurredAt: row.occurredAt?.toISOString() ?? null,
  };
}

export const cycleSchema = z.object({
  id: z.string(),
  name: z.string(),
  schedule: z.string(),
  currency: z.string(),
  delayDays: z.number(),
  cutoffTime: z.string(),
  timezone: z.string(),
  minPayoutMinor: minor,
  active: z.boolean(),
});

export function toCycleView(row: CycleRow) {
  return {
    id: row.ref,
    name: row.name,
    schedule: row.schedule,
    currency: row.currency,
    delayDays: row.delayDays,
    cutoffTime: row.cutoffTime,
    timezone: row.timezone,
    minPayoutMinor: row.minPayoutMinor.toString(),
    active: row.active,
  };
}
