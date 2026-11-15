/**
 * Reads of posted balances (spec 6.7). Holds and reserves arrive with their modules; until
 * then `posted` is the only component that exists.
 */
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';
import { AccountsService } from '../accounts/accounts.service';
import type { LedgerEnvironment, NormalBalance } from '../accounts/domain/chart-of-accounts';
import { BalancesRepository } from './balances.repository';
import { postedBalance } from './domain/posted-balance';

export interface AccountBalanceView {
  readonly accountCode: string;
  readonly currency: string;
  readonly postedDebitsMinor: bigint;
  readonly postedCreditsMinor: bigint;
  /** On the account's normal side; see postedBalance. */
  readonly postedMinor: bigint;
}

@Injectable()
export class BalancesService {
  constructor(
    private readonly balances: BalancesRepository,
    private readonly accounts: AccountsService
  ) {}

  /** Every currency the account has been posted in. */
  async forAccount(environment: LedgerEnvironment, code: string): Promise<AccountBalanceView[]> {
    const account = await this.accounts.findByCode(environment, code);
    if (!account) throw new AppError('NOT_FOUND');
    const rows = await this.balances.listForAccount(account.id);
    return rows.map((row) => ({
      accountCode: account.code,
      currency: row.currency,
      postedDebitsMinor: row.postedDebitsMinor,
      postedCreditsMinor: row.postedCreditsMinor,
      postedMinor: postedBalance(
        account.normalBalance as NormalBalance,
        row.postedDebitsMinor,
        row.postedCreditsMinor
      ),
    }));
  }

  /** Every account and currency of a merchant in one environment. */
  async forMerchant(
    merchantId: string,
    environment: LedgerEnvironment
  ): Promise<AccountBalanceView[]> {
    const rows = await this.balances.listForMerchant(merchantId, environment);
    return rows.map((row) => ({
      accountCode: row.code,
      currency: row.currency,
      postedDebitsMinor: row.postedDebitsMinor,
      postedCreditsMinor: row.postedCreditsMinor,
      postedMinor: postedBalance(
        row.normalBalance as NormalBalance,
        row.postedDebitsMinor,
        row.postedCreditsMinor
      ),
    }));
  }
}
