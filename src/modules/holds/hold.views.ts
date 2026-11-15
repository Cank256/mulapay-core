/** Merchant-facing shape of a hold (spec 6.7, 7.1 `/v1/holds`). Internal ids and keys never leave. */
import { z } from 'zod';
import type { HoldRow } from './holds.repository';

export const holdSchema = z.object({
  id: z.string(),
  environment: z.enum(['test', 'live']),
  currency: z.string(),
  amountMinor: z.string(),
  state: z.enum(['active', 'captured', 'released', 'expired']),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type HoldView = z.infer<typeof holdSchema>;

export function toHoldView(row: HoldRow): HoldView {
  return {
    id: row.ref,
    environment: row.environment as HoldView['environment'],
    currency: row.currency,
    amountMinor: row.amountMinor.toString(),
    state: row.state as HoldView['state'],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
