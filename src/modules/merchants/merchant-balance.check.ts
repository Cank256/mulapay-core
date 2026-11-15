/**
 * Closing a merchant requires a zero balance or an explicit admin write-off (spec 6.10).
 *
 * Bound to the ledger-backed LedgerMerchantBalanceCheck (src/modules/balances) since
 * Phase 2. The write-off path needs the approvals workflow (Phase 4).
 */
import type { Executor } from '../../common/db/database.types';

export interface MerchantBalanceCheck {
  /** True when any live posted amount is non-zero. Reads within `tx` when given. */
  hasNonZeroBalance(merchantId: string, tx?: Executor): Promise<boolean>;
}

export const MERCHANT_BALANCE_CHECK = Symbol('MERCHANT_BALANCE_CHECK');
