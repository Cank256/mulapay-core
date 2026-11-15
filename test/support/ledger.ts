/**
 * Integration fixtures for the ledger (Phase 2): the production app with LedgerModule
 * added, merchants created through MerchantsService (so their accounts are opened the
 * production way), per-test bank accounts, and raw pg clients as mulapay_core_rw and as
 * the superuser for tests that must bypass the application role.
 *
 * Test files run in parallel against one database, so every test works on accounts it
 * created (a merchant or a bank account with a random key) or filters shared results to
 * its own rows.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Client } from 'pg';
import pino from 'pino';
import { inject } from 'vitest';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import type { CurrencyCode } from '../../src/common/money/currency-codes';
import { AccountsService } from '../../src/modules/accounts/accounts.service';
import {
  merchantAccountCode,
  type LedgerEnvironment,
} from '../../src/modules/accounts/domain/chart-of-accounts';
import { BalancesService } from '../../src/modules/balances/balances.service';
import {
  ledgerIdempotencyKey,
  type PostEntryInput,
  type PostingLineInput,
} from '../../src/modules/ledger/domain/posting';
import { LedgerIntegrityService } from '../../src/modules/ledger/ledger-integrity.service';
import { LedgerModule } from '../../src/modules/ledger/ledger.module';
import { PostingService } from '../../src/modules/ledger/posting.service';
import { ReversalService } from '../../src/modules/ledger/reversal.service';
import { MerchantsRepository } from '../../src/modules/merchants/merchants.repository';
import { MerchantsService } from '../../src/modules/merchants/merchants.service';
import { createTestApp } from './test-app';
import { testConfig } from './test-env';

export interface LedgerContext {
  readonly app: NestFastifyApplication;
  readonly posting: PostingService;
  readonly reversal: ReversalService;
  readonly integrity: LedgerIntegrityService;
  readonly accounts: AccountsService;
  readonly balances: BalancesService;
  readonly unitOfWork: UnitOfWork;
  readonly merchants: MerchantsService;
  readonly merchantsRepository: MerchantsRepository;
  close(): Promise<void>;
}

export async function startLedgerContext(
  overrides: Record<string, string> = {}
): Promise<LedgerContext> {
  const logger = pino({ level: process.env.TEST_LOGS ? 'error' : 'silent' });
  const app = await createTestApp(testConfig({ DB_POOL_MAX: '20', ...overrides }), {
    logger,
    extraImports: [LedgerModule],
  });
  const get = <T>(token: new (...args: never[]) => T): T => app.get(token, { strict: false });
  return {
    app,
    posting: get(PostingService),
    reversal: get(ReversalService),
    integrity: get(LedgerIntegrityService),
    accounts: get(AccountsService),
    balances: get(BalancesService),
    unitOfWork: get(UnitOfWork),
    merchants: get(MerchantsService),
    merchantsRepository: get(MerchantsRepository),
    close: () => app.close(),
  };
}

export interface TestMerchant {
  readonly id: string;
  readonly ref: string;
  readonly payable: string;
  readonly reserve: string;
}

/** A merchant created by MerchantsService.create, with its account codes. */
export async function createMerchant(ctx: LedgerContext): Promise<TestMerchant> {
  const { merchant } = await ctx.merchants.create(
    {
      legalName: `Ledger Test ${randomBytes(4).toString('hex')}`,
      country: 'UG',
      defaultCurrency: 'UGX',
    },
    { userId: randomUUID() }
  );
  const row = await ctx.merchantsRepository.findByRef(merchant.id);
  if (!row) throw new Error('merchant not found after create');
  return {
    id: row.id,
    ref: row.ref,
    payable: merchantAccountCode('merchant_payable', row.ref),
    reserve: merchantAccountCode('merchant_reserve', row.ref),
  };
}

/** A bank account with a random key, so no other test posts to it. */
export async function createBankAccount(
  ctx: LedgerContext,
  environment: LedgerEnvironment = 'test',
  currency: CurrencyCode = 'UGX'
): Promise<string> {
  const key = `t${randomBytes(6).toString('hex')}`;
  const row = await ctx.unitOfWork.run((tx) =>
    ctx.accounts.openBankAccount(tx, {
      environment,
      bankKey: key,
      name: `Test bank ${key}`,
      currency,
    })
  );
  return row.code;
}

export const SYSTEM_ACTOR = { type: 'system', id: 'ledger-test' } as const;

export function line(
  accountCode: string,
  direction: 'debit' | 'credit',
  amountMinor: bigint
): PostingLineInput {
  return { accountCode, direction, amountMinor };
}

/** A valid posting input with a fresh source id; override any field. */
export function postingInput(
  lines: readonly PostingLineInput[],
  overrides: Partial<PostEntryInput> = {}
): PostEntryInput {
  const source = overrides.source ?? 'adjustment';
  const sourceId = overrides.sourceId ?? `src_${randomUUID()}`;
  return {
    idempotencyKey: ledgerIdempotencyKey(source, sourceId),
    environment: 'test',
    currency: 'UGX',
    source,
    sourceId,
    description: 'ledger integration test',
    lines,
    createdBy: SYSTEM_ACTOR,
    ...overrides,
  };
}

/** Posts in its own transaction. */
export function post(ctx: LedgerContext, input: PostEntryInput) {
  return ctx.unitOfWork.run((tx) => ctx.posting.postEntry(tx, input));
}

/** Posted balance of one account in one currency (0 when never posted). */
export async function postedMinor(
  ctx: LedgerContext,
  code: string,
  currency: CurrencyCode = 'UGX',
  environment: LedgerEnvironment = 'test'
): Promise<bigint> {
  const rows = await ctx.balances.forAccount(environment, code);
  return rows.find((r) => r.currency === currency)?.postedMinor ?? 0n;
}

export async function connect(role: 'rw' | 'superuser'): Promise<Client> {
  const urls = inject('databaseUrls');
  const client = new Client({ connectionString: role === 'rw' ? urls.rw : urls.superuser });
  await client.connect();
  return client;
}
