/**
 * Closing a merchant requires a zero balance or an explicit admin write-off (spec 6.10).
 *
 * The ledger, balances and the approvals workflow (needed for a write-off) arrive in
 * Phases 2 and 4. Until then no merchant can hold a balance: there are no journal or
 * balance tables to hold one. `NoLedgerYetBalanceCheck` states that fact. Phase 2 must
 * bind MERCHANT_BALANCE_CHECK to a ledger-backed implementation; this is tracked in
 * docs/ARCHITECTURE.md ("Phase 1 decisions to confirm").
 */
import { Injectable } from '@nestjs/common';

export interface MerchantBalanceCheck {
  /** True when any posted, pending, held or reserved amount is non-zero. */
  hasNonZeroBalance(merchantId: string): Promise<boolean>;
}

export const MERCHANT_BALANCE_CHECK = Symbol('MERCHANT_BALANCE_CHECK');

@Injectable()
export class NoLedgerYetBalanceCheck implements MerchantBalanceCheck {
  async hasNonZeroBalance(): Promise<boolean> {
    return false;
  }
}
