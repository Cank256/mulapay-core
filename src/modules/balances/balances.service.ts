/**
 * Balances (spec 6.7): posted balances per account, and the merchant balance
 * `available = posted - held - reserved` with the informational `pending`.
 *
 * `reserved` is zero until Phase 6 builds `reserve_entries`. The rolling-reserve posting of
 * spec 5.5 already moves the reserve out of the payable account, so subtracting reserves
 * again here would count them twice; Phase 6 must settle that before reserves exist
 * (docs/ARCHITECTURE.md, Phase 4 decisions).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { AppError } from '../../common/errors/app-error';
import { CLOCK } from '../../common/tokens';
import { AccountsService } from '../accounts/accounts.service';
import type { LedgerEnvironment, NormalBalance } from '../accounts/domain/chart-of-accounts';
import { BalancesRepository } from './balances.repository';
import { availableBalance, postedBalance } from './domain/posted-balance';

export interface AccountBalanceView {
  readonly accountCode: string;
  readonly currency: string;
  readonly postedDebitsMinor: bigint;
  readonly postedCreditsMinor: bigint;
  /** On the account's normal side; see postedBalance. */
  readonly postedMinor: bigint;
}

/** Pending payments older than this are no longer counted (partition pruning, spec 9.2). */
const PENDING_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
export interface MerchantBalanceView {
  readonly currency: string;
  /** Payable account balance, credit side positive. */
  readonly postedMinor: bigint;
  /** Sum of active holds. */
  readonly heldMinor: bigint;
  /** Payments in `processing`. Informational: never spendable. */
  readonly pendingMinor: bigint;
  readonly reservedMinor: bigint;
  /** `posted - held - reserved`. What payouts, refunds and settlement draw on. */
  readonly availableMinor: bigint;
}
@Injectable()
export class BalancesService {
  constructor(
    private readonly balances: BalancesRepository,
    private readonly accounts: AccountsService,
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}
  /** One merchant balance, read without locking. */
  async merchantBalance(
    merchantId: string,
    environment: LedgerEnvironment,
    currency: string,
    tx: Executor = this.db
  ): Promise<MerchantBalanceView> {
    const payable = await this.balances.readPayable(tx, merchantId, environment, currency);
    return this.assemble(tx, merchantId, environment, currency, payable.debits, payable.credits);
  }
  /** Every currency the merchant holds a payable balance or an active hold in. */
  async merchantBalances(
    merchantId: string,
    environment: LedgerEnvironment,
    tx: Executor = this.db
  ): Promise<MerchantBalanceView[]> {
    const currencies = await this.balances.currenciesInUse(tx, merchantId, environment);
    return Promise.all(
      currencies.map((currency) => this.merchantBalance(merchantId, environment, currency, tx))
    );
  }
  /**
   * The balance with the payable row locked until the transaction ends. Placing a hold
   * uses this, so concurrent placements serialise and cannot reserve the same funds twice.
   */
  async lockedMerchantBalance(
    tx: Executor,
    merchantId: string,
    environment: LedgerEnvironment,
    currency: string
  ): Promise<MerchantBalanceView & { readonly accountId: string }> {
    const payable = await this.balances.lockPayable(tx, merchantId, environment, currency);
    if (!payable) throw new AppError('LEDGER_ACCOUNT_NOT_FOUND', { details: { environment } });
    const view = await this.assemble(
      tx,
      merchantId,
      environment,
      currency,
      payable.debits,
      payable.credits
    );
    return { ...view, accountId: payable.accountId };
  }
  private async assemble(
    tx: Executor,
    merchantId: string,
    environment: LedgerEnvironment,
    currency: string,
    debits: bigint,
    credits: bigint
  ): Promise<MerchantBalanceView> {
    const since = new Date(this.clock.now().getTime() - PENDING_WINDOW_DAYS * DAY_MS);
    const [heldMinor, pendingMinor] = await Promise.all([
      this.balances.sumActiveHolds(tx, merchantId, environment, currency),
      this.balances.sumProcessingPayments(tx, merchantId, environment, currency, since),
    ]);
    const postedMinor = postedBalance('credit', debits, credits);
    const reservedMinor = 0n;
    return {
      currency,
      postedMinor,
      heldMinor,
      pendingMinor,
      reservedMinor,
      availableMinor: availableBalance({ postedMinor, heldMinor, reservedMinor }),
    };
  }

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
