/**
 * Merchant-facing shapes of transactions and their timeline (spec 6.5). Internal ids, the
 * gateway operation and reference ids, failure reasons (which can carry provider wording)
 * and rejected events never leave the service: the response schema is also the allowlist
 * the serializer applies (spec 9.2 rule 1).
 *
 * Amounts are strings of minor units: a JSON number cannot hold every bigint.
 */
import { z } from 'zod';
import type { TransactionEventRow, TransactionRow } from './transactions.repository';

export const timelineEntrySchema = z.object({
  status: z.string(),
  previousStatus: z.string().nullable(),
  failureCode: z.string().nullable(),
  occurredAt: z.iso.datetime(),
});
export type TimelineEntryView = z.infer<typeof timelineEntrySchema>;

export const transactionSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  environment: z.enum(['test', 'live']),
  amountMinor: z.string(),
  feeMinor: z.string(),
  netMinor: z.string(),
  currency: z.string(),
  provider: z.string().nullable(),
  channel: z.string(),
  externalId: z.string().nullable(),
  providerTransactionId: z.string().nullable(),
  failureCode: z.string().nullable(),
  initiatedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
});
export type TransactionView = z.infer<typeof transactionSchema>;

export const transactionDetailSchema = transactionSchema.extend({
  timeline: z.array(timelineEntrySchema),
});
export type TransactionDetailView = z.infer<typeof transactionDetailSchema>;

export const transactionPageSchema = z.object({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
});

export function toTransactionView(row: TransactionRow): TransactionView {
  return {
    id: row.ref,
    type: row.type,
    status: row.status,
    environment: row.environment as TransactionView['environment'],
    amountMinor: row.amountMinor.toString(),
    feeMinor: row.feeMinor.toString(),
    netMinor: row.netMinor.toString(),
    currency: row.currency,
    provider: row.provider,
    channel: row.channel,
    externalId: row.gatewayExternalId,
    providerTransactionId: row.providerTransactionId,
    failureCode: row.failureCode,
    initiatedAt: row.initiatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The merchant's view of what happened: events that changed the status. Repeats, no-ops
 * and refused events are internal.
 */
export function toTimeline(events: readonly TransactionEventRow[]): TimelineEntryView[] {
  return events
    .filter((e) => e.outcome === 'applied' && e.fromStatus !== e.toStatus)
    .map((e) => ({
      status: e.toStatus,
      previousStatus: e.fromStatus,
      failureCode: e.failureCode,
      occurredAt: e.occurredAt.toISOString(),
    }));
}
