/** Merchant-facing balance (spec 6.7, 7.1 `/v1/balances`): amounts are strings of minor units. */
import { z } from 'zod';
import type { LedgerEnvironment } from '../accounts/domain/chart-of-accounts';
import type { MerchantBalanceView } from './balances.service';

export const merchantBalanceSchema = z.object({
  environment: z.enum(['test', 'live']),
  currency: z.string(),
  postedMinor: z.string(),
  availableMinor: z.string(),
  pendingMinor: z.string(),
  heldMinor: z.string(),
  reservedMinor: z.string(),
});
export type MerchantBalanceResponse = z.infer<typeof merchantBalanceSchema>;

export function toMerchantBalanceView(
  environment: LedgerEnvironment,
  balance: MerchantBalanceView
): MerchantBalanceResponse {
  return {
    environment,
    currency: balance.currency,
    postedMinor: balance.postedMinor.toString(),
    availableMinor: balance.availableMinor.toString(),
    pendingMinor: balance.pendingMinor.toString(),
    heldMinor: balance.heldMinor.toString(),
    reservedMinor: balance.reservedMinor.toString(),
  };
}
