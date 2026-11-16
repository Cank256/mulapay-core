/** Dashboard analytics responses (spec 7.2). Amounts are strings of minor units. */
import { z } from 'zod';
import type { CurrencyTotals } from './rollups.service';
import type { RollupChannelRow, RollupSeriesRow } from './rollups.repository';

const minor = z.string().regex(/^\d+$/);
const window = { from: z.string(), to: z.string() };

export const overviewAnalyticsSchema = z.object({
  ...window,
  currencies: z.array(
    z.object({
      currency: z.string(),
      paymentCount: z.number().int(),
      paymentMinor: minor,
      refundCount: z.number().int(),
      refundMinor: minor,
      payoutCount: z.number().int(),
      payoutMinor: minor,
      feeMinor: minor,
      successCount: z.number().int(),
      failureCount: z.number().int(),
      successRate: z.number().nullable(),
    })
  ),
});

export const volumeAnalyticsSchema = z.object({
  ...window,
  points: z.array(
    z.object({
      day: z.string(),
      currency: z.string(),
      paymentCount: z.number().int(),
      paymentMinor: minor,
      refundMinor: minor,
      payoutMinor: minor,
      feeMinor: minor,
    })
  ),
});

export const successRateAnalyticsSchema = z.object({
  ...window,
  points: z.array(
    z.object({
      day: z.string(),
      currency: z.string(),
      successCount: z.number().int(),
      failureCount: z.number().int(),
      successRate: z.number().nullable(),
    })
  ),
});

export const channelsAnalyticsSchema = z.object({
  ...window,
  channels: z.array(
    z.object({
      channel: z.string(),
      provider: z.string(),
      currency: z.string(),
      paymentCount: z.number().int(),
      paymentMinor: minor,
      successCount: z.number().int(),
      failureCount: z.number().int(),
      successRate: z.number().nullable(),
    })
  ),
});

export const toOverviewAnalytics = (w: {
  from: string;
  to: string;
  currencies: CurrencyTotals[];
}) => ({
  from: w.from,
  to: w.to,
  currencies: w.currencies.map((c) => ({
    ...c,
    paymentMinor: c.paymentMinor.toString(),
    refundMinor: c.refundMinor.toString(),
    payoutMinor: c.payoutMinor.toString(),
    feeMinor: c.feeMinor.toString(),
  })),
});

export const toVolumeAnalytics = (w: { from: string; to: string; points: RollupSeriesRow[] }) => ({
  from: w.from,
  to: w.to,
  points: w.points.map((p) => ({
    day: p.day,
    currency: p.currency,
    paymentCount: p.paymentCount,
    paymentMinor: p.paymentMinor.toString(),
    refundMinor: p.refundMinor.toString(),
    payoutMinor: p.payoutMinor.toString(),
    feeMinor: p.feeMinor.toString(),
  })),
});

export const toChannelsAnalytics = (w: {
  from: string;
  to: string;
  channels: Array<RollupChannelRow & { successRate: number | null }>;
}) => ({
  from: w.from,
  to: w.to,
  channels: w.channels.map((c) => ({ ...c, paymentMinor: c.paymentMinor.toString() })),
});
