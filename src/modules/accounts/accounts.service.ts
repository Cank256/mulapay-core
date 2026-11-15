/**
 * Chart of accounts use cases (spec 5.4, 6.6): opening merchant and bank accounts and
 * resolving account codes for a posting. Platform and provider accounts are seeded by
 * migration 0002; nothing here creates them.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import type { CurrencyCode } from '../../common/money/currency-codes';
import { CLOCK } from '../../common/tokens';
import { AccountsRepository, type AccountRow, type NewAccount } from './accounts.repository';
import {
  ACCOUNT_PURPOSES,
  bankAccountCode,
  merchantAccountCode,
  MERCHANT_PURPOSES,
  normalBalanceOf,
  type LedgerEnvironment,
} from './domain/chart-of-accounts';

const ENVIRONMENTS: readonly LedgerEnvironment[] = ['test', 'live'];

export interface OpenBankAccountInput {
  readonly environment: LedgerEnvironment;
  /** Short key that names the bank account in its code: `1100:bank:{bankKey}`. */
  readonly bankKey: string;
  readonly name: string;
  /** A bank account holds one currency. */
  readonly currency: CurrencyCode;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly accounts: AccountsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Opens the payable and reserve accounts of a merchant in both environments. Called in
   * the transaction that creates the merchant. Idempotent.
   */
  async openMerchantAccounts(
    tx: Executor,
    merchant: { readonly id: string; readonly ref: string }
  ): Promise<void> {
    const now = this.clock.now();
    const rows: NewAccount[] = [];
    for (const environment of ENVIRONMENTS) {
      for (const purpose of MERCHANT_PURPOSES) {
        const definition = ACCOUNT_PURPOSES[purpose];
        rows.push({
          id: uuidv7(now),
          ref: publicId('account', now),
          environment,
          code: merchantAccountCode(purpose, merchant.ref),
          name: `${definition.name} (${merchant.ref})`,
          type: definition.type,
          normalBalance: normalBalanceOf(definition.type),
          merchantId: merchant.id,
          purpose,
          isSystem: false,
        });
      }
    }
    await this.accounts.insertMissing(tx, rows);
  }

  /** Opens a platform bank account (`1100:bank:{bankKey}`). Idempotent on the code. */
  async openBankAccount(tx: Executor, input: OpenBankAccountInput): Promise<AccountRow> {
    const now = this.clock.now();
    const code = bankAccountCode(input.bankKey);
    await this.accounts.insertMissing(tx, [
      {
        id: uuidv7(now),
        ref: publicId('account', now),
        environment: input.environment,
        code,
        name: input.name,
        type: ACCOUNT_PURPOSES.bank.type,
        normalBalance: normalBalanceOf(ACCOUNT_PURPOSES.bank.type),
        currency: input.currency,
        purpose: 'bank',
        isSystem: true,
      },
    ]);
    const row = await this.accounts.findByCode(input.environment, code, tx);
    if (!row) throw new Error('bank account insert returned no row');
    return row;
  }

  /**
   * Resolves the account codes of a posting in one query. Every code must exist in the
   * environment and be active; otherwise the posting is refused before anything is written.
   */
  async resolveForPosting(
    tx: Executor,
    environment: LedgerEnvironment,
    codes: readonly string[]
  ): Promise<Map<string, AccountRow>> {
    const unique = [...new Set(codes)];
    const rows = await this.accounts.findByCodes(tx, environment, unique);
    const byCode = new Map(rows.map((row) => [row.code, row]));
    for (const code of unique) {
      const row = byCode.get(code);
      if (!row) throw new AppError('LEDGER_ACCOUNT_NOT_FOUND', { details: { code, environment } });
      if (!row.active) throw new AppError('LEDGER_ACCOUNT_INACTIVE', { details: { code } });
    }
    return byCode;
  }

  findByCode(environment: LedgerEnvironment, code: string): Promise<AccountRow | undefined> {
    return this.accounts.findByCode(environment, code);
  }

  listForMerchant(merchantId: string): Promise<AccountRow[]> {
    return this.accounts.listForMerchant(merchantId);
  }
}
