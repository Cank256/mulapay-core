/**
 * Ledger-backed MERCHANT_BALANCE_CHECK (spec 6.10: closing needs a zero balance). Replaces
 * Phase 1's NoLedgerYetBalanceCheck.
 *
 * Only live accounts count: test-mode balances are not money the platform owes. Held and
 * reserved amounts are part of the posted balance of the payable and reserve accounts;
 * pending payments have no ledger effect until they succeed (spec 5.5).
 */
import { Injectable } from '@nestjs/common';
import type { Executor } from '../../common/db/database.types';
import type { MerchantBalanceCheck } from '../merchants/merchant-balance.check';
import { BalancesRepository } from './balances.repository';

@Injectable()
export class LedgerMerchantBalanceCheck implements MerchantBalanceCheck {
  constructor(private readonly balances: BalancesRepository) {}

  hasNonZeroBalance(merchantId: string, tx?: Executor): Promise<boolean> {
    return this.balances.merchantHasNonZeroLiveBalance(merchantId, tx);
  }
}
