/**
 * Integration fixtures for the payment and transaction domain: merchants with test and live
 * API keys, an HTTP client per key, the domain services from the running app, and helpers
 * that feed lifecycle events the way the gateway consumer will.
 *
 * Test files run in parallel against one database, so every test creates its own merchant and
 * works on its own payments.
 */
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { inject } from 'vitest';
import type { MerchantScope } from '../../src/common/auth/merchant-scope';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { PostingService } from '../../src/modules/ledger/posting.service';
import { MerchantsRepository } from '../../src/modules/merchants/merchants.repository';
import { CheckoutSessionsService } from '../../src/modules/payments/checkout-sessions.service';
import type {
  PaymentEventInput,
  PaymentSignal,
} from '../../src/modules/payments/domain/payment-event';
import { PaymentExpiryService } from '../../src/modules/payments/payment-expiry.service';
import {
  PaymentLifecycleService,
  type ApplyOptions,
} from '../../src/modules/payments/payment-lifecycle.service';
import { PaymentLinksService } from '../../src/modules/payments/payment-links.service';
import { PaymentsRepository } from '../../src/modules/payments/payments.repository';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { TransactionsService } from '../../src/modules/transactions/transactions.service';
import {
  activateMerchantDirectly,
  Client,
  registerMerchantUser,
  startContext,
  type MerchantUser,
  type TestContext,
} from './identity';

export interface PaymentsContext extends TestContext {
  readonly lifecycle: PaymentLifecycleService;
  readonly payments: PaymentsService;
  readonly paymentsRepository: PaymentsRepository;
  readonly links: PaymentLinksService;
  readonly sessions: CheckoutSessionsService;
  readonly expiry: PaymentExpiryService;
  readonly transactions: TransactionsService;
  readonly posting: PostingService;
  readonly unitOfWork: UnitOfWork;
  readonly merchants: MerchantsRepository;
}

export async function startPaymentsContext(
  overrides: Record<string, string> = {}
): Promise<PaymentsContext> {
  const ctx = await startContext({ DB_POOL_MAX: '25', ...overrides });
  const get = <T>(token: new (...args: never[]) => T): T => ctx.app.get(token, { strict: false });
  return {
    ...ctx,
    lifecycle: get(PaymentLifecycleService),
    payments: get(PaymentsService),
    paymentsRepository: get(PaymentsRepository),
    links: get(PaymentLinksService),
    sessions: get(CheckoutSessionsService),
    expiry: get(PaymentExpiryService),
    transactions: get(TransactionsService),
    posting: get(PostingService),
    unitOfWork: get(UnitOfWork),
    merchants: get(MerchantsRepository),
  };
}

const ALL_SCOPES = ['payments:read', 'payments:write', 'transactions:read'];

/** A client authenticated with one API key. */
export function apiClient(ctx: TestContext, key: string): Client {
  const client = new Client(ctx.app);
  client.token = key;
  return client;
}

export interface TestMerchant {
  readonly owner: MerchantUser;
  readonly ref: string;
  readonly id: string;
  readonly testKey: string;
  readonly test: Client;
  /** Present when the merchant was activated. */
  readonly liveKey?: string;
  readonly live?: Client;
  readonly scope: (environment?: 'test' | 'live') => MerchantScope;
}

async function issueKey(
  owner: MerchantUser,
  environment: 'test' | 'live',
  scopes: string[]
): Promise<string> {
  const res = await owner.client.post('/merchant/v1/api-keys', {
    name: `${environment} key`,
    environment,
    scopes,
  });
  if (res.statusCode !== 201) throw new Error(`api key failed: ${res.body}`);
  return res.json().data.key as string;
}

/**
 * A merchant with a test key (and, with `active`, an activated merchant and a live key).
 * `scopes` defaults to everything the payment routes use.
 */
export async function createTestMerchant(
  ctx: PaymentsContext,
  options: { active?: boolean; scopes?: string[]; label?: string } = {}
): Promise<TestMerchant> {
  const owner = await registerMerchantUser(ctx, options.label ?? 'payer');
  const scopes = options.scopes ?? ALL_SCOPES;
  const testKey = await issueKey(owner, 'test', scopes);
  let liveKey: string | undefined;
  if (options.active) {
    await activateMerchantDirectly(inject('databaseUrls').superuser, owner.merchantId);
    liveKey = await issueKey(owner, 'live', scopes);
  }
  const row = await ctx.merchants.findByRef(owner.merchantId);
  if (!row) throw new Error('merchant not found');
  return {
    owner,
    ref: row.ref,
    id: row.id,
    testKey,
    test: apiClient(ctx, testKey),
    liveKey,
    live: liveKey ? apiClient(ctx, liveKey) : undefined,
    scope: (environment = 'test') => ({
      merchantId: row.id,
      merchantRef: row.ref,
      merchantStatus: options.active ? 'active' : 'draft',
      environment,
    }),
  };
}

export const MSISDN = '+256700000001';

export function idempotencyKey(): string {
  return `idem-${randomUUID()}`;
}

export interface PaymentBody {
  amountMinor?: string | number;
  currency?: string;
  channel?: string;
  paymentMethod?: { provider?: string; msisdn?: string };
  description?: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

/** POST /v1/payments with a fresh idempotency key unless one is given. */
export function postPayment(
  client: Client,
  body: PaymentBody = {},
  key: string | null = idempotencyKey()
) {
  return client.post(
    '/v1/payments',
    {
      amountMinor: '10000',
      currency: 'UGX',
      paymentMethod: { msisdn: MSISDN },
      ...body,
    },
    key === null ? {} : { 'idempotency-key': key }
  );
}

/** Creates a payment over HTTP and returns its view. */
export async function createPayment(client: Client, body: PaymentBody = {}) {
  const res = await postPayment(client, body);
  if (res.statusCode !== 201) throw new Error(`create payment failed: ${res.body}`);
  return res.json().data as {
    id: string;
    transactionId: string;
    status: string;
    amountMinor: string;
    currency: string;
  };
}

export async function paymentId(ctx: PaymentsContext, m: TestMerchant, ref: string) {
  const detail = await ctx.paymentsRepository.findDetailByRef(m.scope(), ref);
  if (!detail) throw new Error(`payment ${ref} not found`);
  return detail.payment.id;
}

let eventCounter = 0;

/** A fresh event key; the gateway's event ids are unique, and so are these. */
export function eventKey(prefix = 'evt'): string {
  eventCounter += 1;
  return `${prefix}_${randomUUID()}_${eventCounter}`;
}

export function event(
  signal: PaymentSignal,
  overrides: Partial<PaymentEventInput> = {}
): PaymentEventInput {
  return {
    eventKey: eventKey(),
    source: 'gateway_event',
    occurredAt: new Date(),
    signal,
    ...overrides,
  };
}

/** Applies one event in its own transaction, as the consumer will. */
export async function applyEvent(
  ctx: PaymentsContext,
  id: string,
  input: PaymentEventInput,
  options?: ApplyOptions
) {
  return ctx.unitOfWork.run((tx) => ctx.lifecycle.apply(tx, id, input, options));
}

/** Moves a payment to `processing` as the gateway's `pending` event would. */
export function toProcessing(
  ctx: PaymentsContext,
  id: string,
  extra: Partial<PaymentEventInput> = {}
) {
  return applyEvent(
    ctx,
    id,
    event(
      { kind: 'processing', outcomeUnknown: false },
      { identifiers: { provider: 'mtn' }, ...extra }
    )
  );
}

/** One query as the superuser, on its own connection, so it sees only committed data. */
export async function sql<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const pg = new PgClient({ connectionString: inject('databaseUrls').superuser });
  await pg.connect();
  try {
    return (await pg.query(text, values)).rows as T[];
  } finally {
    await pg.end();
  }
}
