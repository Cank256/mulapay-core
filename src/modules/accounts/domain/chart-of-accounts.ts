/**
 * The chart of accounts (spec 5.4). Pure: no I/O.
 *
 * Every account has a `purpose`, which fixes its code number, its type and therefore its
 * normal balance. Codes are `{number}:{purpose}` for platform accounts and
 * `{number}:{purpose}:{qualifier}` for accounts that exist once per provider, per bank
 * account or per merchant. The database repeats these rules as CHECK constraints
 * (migration 0002), so an account that disagrees with this table cannot be stored.
 *
 * Accounts are multi-currency unless `currency` is set: balances are kept per
 * (account, currency) in `account_balances` (spec 5.2). Accounts are also per
 * environment, so test postings can never touch a live account (spec section 5).
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type LedgerEnvironment = 'test' | 'live';

/** What the qualifier after the purpose identifies, if anything. */
export type AccountScope = 'platform' | 'provider' | 'bank' | 'merchant';

export interface AccountPurposeDefinition {
  readonly number: string;
  readonly type: AccountType;
  readonly scope: AccountScope;
  readonly name: string;
}

export const ACCOUNT_PURPOSES = {
  provider_clearing: {
    number: '1000',
    type: 'asset',
    scope: 'provider',
    name: 'Provider clearing',
  },
  provider_float: { number: '1010', type: 'asset', scope: 'provider', name: 'Provider float' },
  bank: { number: '1100', type: 'asset', scope: 'bank', name: 'Bank account' },
  settlement_in_transit: {
    number: '1200',
    type: 'asset',
    scope: 'platform',
    name: 'Settlement in transit',
  },
  fx_clearing: { number: '1900', type: 'asset', scope: 'platform', name: 'FX clearing' },
  merchant_payable: {
    number: '2000',
    type: 'liability',
    scope: 'merchant',
    name: 'Merchant payable',
  },
  merchant_reserve: {
    number: '2010',
    type: 'liability',
    scope: 'merchant',
    name: 'Merchant reserve',
  },
  refund_payable: {
    number: '2100',
    type: 'liability',
    scope: 'platform',
    name: 'Refund payable',
  },
  tax_payable: { number: '2200', type: 'liability', scope: 'platform', name: 'Tax payable' },
  fee_revenue: { number: '4000', type: 'revenue', scope: 'platform', name: 'Fee revenue' },
  fx_revenue: { number: '4100', type: 'revenue', scope: 'platform', name: 'FX revenue' },
  provider_fee_expense: {
    number: '5000',
    type: 'expense',
    scope: 'platform',
    name: 'Provider fee expense',
  },
  loss_writeoff: { number: '5100', type: 'expense', scope: 'platform', name: 'Loss write-off' },
  suspense: { number: '9000', type: 'asset', scope: 'platform', name: 'Suspense' },
} as const satisfies Record<string, AccountPurposeDefinition>;

export type AccountPurpose = keyof typeof ACCOUNT_PURPOSES;
export type PlatformPurpose = {
  [P in AccountPurpose]: (typeof ACCOUNT_PURPOSES)[P]['scope'] extends 'platform' ? P : never;
}[AccountPurpose];
export type ProviderPurpose = 'provider_clearing' | 'provider_float';
export type MerchantPurpose = 'merchant_payable' | 'merchant_reserve';

export const ACCOUNT_PURPOSE_KEYS = Object.keys(ACCOUNT_PURPOSES) as AccountPurpose[];

/** Providers the gateway serves (spec 3.2). One clearing and one float account each. */
export const LEDGER_PROVIDERS = ['mtn', 'airtel', 'flutterwave'] as const;
export type LedgerProvider = (typeof LEDGER_PROVIDERS)[number];

export const MERCHANT_PURPOSES: readonly MerchantPurpose[] = [
  'merchant_payable',
  'merchant_reserve',
];

/** Liability accounts the platform owes a merchant. They must not go into a debit position. */
export function isMerchantPurpose(purpose: string): purpose is MerchantPurpose {
  return (MERCHANT_PURPOSES as readonly string[]).includes(purpose);
}

export function normalBalanceOf(type: AccountType): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

const QUALIFIER = {
  provider: /^(mtn|airtel|flutterwave)$/,
  bank: /^[a-z0-9_]{2,40}$/,
  merchant: /^mch_[0-9A-HJKMNP-TV-Z]{26}$/,
} as const;

/** Shape of every account code, checked again by the database. */
export const ACCOUNT_CODE_PATTERN = /^[0-9]{4}:[a-z_]+(:[A-Za-z0-9_]+)?$/;

export interface ParsedAccountCode {
  readonly purpose: AccountPurpose;
  readonly qualifier: string | null;
}

/** Parses and fully validates an account code. Returns undefined when it is not valid. */
export function parseAccountCode(code: string): ParsedAccountCode | undefined {
  if (!ACCOUNT_CODE_PATTERN.test(code)) return undefined;
  const [number, purpose, qualifier] = code.split(':');
  if (!Object.hasOwn(ACCOUNT_PURPOSES, purpose as string)) return undefined;
  const definition: AccountPurposeDefinition = ACCOUNT_PURPOSES[purpose as AccountPurpose];
  if (definition.number !== number) return undefined;
  if (definition.scope === 'platform') {
    return qualifier === undefined
      ? { purpose: purpose as AccountPurpose, qualifier: null }
      : undefined;
  }
  if (qualifier === undefined || !QUALIFIER[definition.scope].test(qualifier)) return undefined;
  return { purpose: purpose as AccountPurpose, qualifier };
}

export function isAccountCode(code: string): boolean {
  return parseAccountCode(code) !== undefined;
}

export function platformAccountCode(purpose: PlatformPurpose): string {
  return `${ACCOUNT_PURPOSES[purpose].number}:${purpose}`;
}

export function providerAccountCode(purpose: ProviderPurpose, provider: LedgerProvider): string {
  return `${ACCOUNT_PURPOSES[purpose].number}:${purpose}:${provider}`;
}

/** Merchant accounts are qualified by the merchant's public ref, never its internal id. */
export function merchantAccountCode(purpose: MerchantPurpose, merchantRef: string): string {
  const code = `${ACCOUNT_PURPOSES[purpose].number}:${purpose}:${merchantRef}`;
  if (!isAccountCode(code)) throw new Error('merchantAccountCode needs a merchant ref (mch_...)');
  return code;
}

export function bankAccountCode(bankKey: string): string {
  const code = `${ACCOUNT_PURPOSES.bank.number}:bank:${bankKey}`;
  if (!isAccountCode(code)) throw new Error('bank account keys are 2 to 40 of [a-z0-9_]');
  return code;
}

export interface SeededAccount {
  readonly code: string;
  readonly purpose: AccountPurpose;
  readonly provider: LedgerProvider | null;
  readonly name: string;
}

/**
 * The platform and provider accounts seeded by migration 0002 in each environment. Bank
 * accounts (1100) are opened per real bank account and merchant accounts per merchant.
 */
export function seededAccounts(): SeededAccount[] {
  const accounts: SeededAccount[] = [];
  for (const purpose of ACCOUNT_PURPOSE_KEYS) {
    const definition: AccountPurposeDefinition = ACCOUNT_PURPOSES[purpose];
    if (definition.scope === 'platform') {
      accounts.push({
        code: platformAccountCode(purpose as PlatformPurpose),
        purpose,
        provider: null,
        name: definition.name,
      });
    } else if (definition.scope === 'provider') {
      for (const provider of LEDGER_PROVIDERS) {
        accounts.push({
          code: providerAccountCode(purpose as ProviderPurpose, provider),
          purpose,
          provider,
          name: `${definition.name} (${provider})`,
        });
      }
    }
  }
  return accounts;
}
