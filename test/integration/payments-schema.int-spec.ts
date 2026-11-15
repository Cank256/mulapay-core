/**
 * Payment and transaction invariants enforced by Postgres itself (spec 5, 6.1, AGENTS.md):
 * each is violated with plain SQL as mulapay_core_rw, bypassing every service, and must fail.
 * Where a trigger backs a revoked privilege the superuser proves the trigger too.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PAYMENT_STATUSES,
  canTransition,
} from '../../src/modules/payments/domain/payment-state-machine';
import { connect } from '../support/ledger';
import {
  createTestMerchant,
  startPaymentsContext,
  type PaymentsContext,
  type TestMerchant,
} from '../support/payments';

let ctx: PaymentsContext;
let rw: Client;
let su: Client;
let merchant: TestMerchant;
let other: TestMerchant;

beforeAll(async () => {
  ctx = await startPaymentsContext();
  [rw, su] = await Promise.all([connect('rw'), connect('superuser')]);
  merchant = await createTestMerchant(ctx, { label: 'schema' });
  other = await createTestMerchant(ctx, { label: 'schema2' });
});

afterAll(async () => {
  await Promise.all([rw?.end(), su?.end()]);
  await ctx?.close();
});

/** Runs `statements` in one transaction; resolves to the pg error code or null if it commits. */
async function failureOf(
  client: Client,
  statements: Array<[string, unknown[]?]>
): Promise<{ code: string; message: string } | null> {
  try {
    await client.query('begin');
    for (const [text, values] of statements) await client.query(text, values);
    await client.query('commit');
    return null;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? 'unknown', message: e.message ?? '' };
  }
}

interface Pair {
  transactionId: string;
  paymentId: string;
  transactionRef: string;
  paymentRef: string;
}

interface PairOptions {
  merchantId?: string;
  environment?: string;
  amount?: bigint;
  currency?: string;
  status?: string;
  channel?: string;
  idempotencyKey?: string;
  externalId?: string | null;
  /** SQL expression for the payment's created_at; defaults to the transaction's. */
  paymentCreatedAt?: string;
}

/** The statements that create a transaction and its payment, to run in one transaction. */
function pairStatements(options: PairOptions = {}): {
  pair: Pair;
  statements: Array<[string, unknown[]]>;
} {
  const pair: Pair = {
    transactionId: randomUUID(),
    paymentId: randomUUID(),
    transactionRef: `txn_${randomUUID()
      .replace(/-/g, '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, 'A')}`,
    paymentRef: `pay_${randomUUID()
      .replace(/-/g, '')
      .slice(0, 26)
      .toUpperCase()
      .replace(/[ILOU]/g, 'A')}`,
  };
  const amount = (options.amount ?? 5000n).toString();
  const environment = options.environment ?? 'test';
  const merchantId = options.merchantId ?? merchant.id;
  const status = options.status ?? 'created';
  return {
    pair,
    statements: [
      [
        `insert into core.transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, gateway_external_id, created_at)
         values ($1, $2, $3, $4, 'payment', $5, $6, 0, $6, $7, $8, $9, now())`,
        [
          pair.transactionId,
          pair.transactionRef,
          merchantId,
          environment,
          status,
          amount,
          options.currency ?? 'UGX',
          options.channel ?? 'mobile_money',
          options.externalId === undefined ? pair.paymentRef : options.externalId,
        ],
      ],
      [
        `insert into core.payments (id, ref, transaction_id, merchant_id, environment, amount_minor, currency, status, channel, idempotency_key, expires_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + interval '15 minutes', ${options.paymentCreatedAt ?? 'now()'})`,
        [
          pair.paymentId,
          pair.paymentRef,
          pair.transactionId,
          merchantId,
          environment,
          amount,
          options.currency ?? 'UGX',
          status,
          options.channel ?? 'mobile_money',
          options.idempotencyKey ?? `key-${randomUUID()}`,
        ],
      ],
    ],
  };
}

async function insertPair(options: PairOptions = {}): Promise<Pair> {
  const { pair, statements } = pairStatements(options);
  const failure = await failureOf(rw, statements);
  if (failure) throw new Error(`insert pair failed: ${failure.message}`);
  return pair;
}

/** Updates both rows in one transaction, as the lifecycle does. */
function moveBoth(pair: Pair, set: string, values: unknown[] = []): Array<[string, unknown[]]> {
  return [
    [
      `update core.transactions set ${set} where id = $${values.length + 1}`,
      [...values, pair.transactionId],
    ],
    [
      `update core.payments set status = (select status from core.transactions where id = $1) where id = $2`,
      [pair.transactionId, pair.paymentId],
    ],
  ];
}

async function advance(pair: Pair, ...path: string[]) {
  for (const status of path) {
    const completed = ['succeeded', 'failed', 'cancelled', 'expired'].includes(status);
    const provider = status === 'succeeded' ? ", provider = coalesce(provider, 'mtn')" : '';
    const failure = await failureOf(
      rw,
      moveBoth(pair, `status = $1${completed ? ', completed_at = now()' : ''}${provider}`, [status])
    );
    if (failure) throw new Error(`advance to ${status} failed: ${failure.message}`);
  }
}

describe('the payment state machine in the database', () => {
  it('agrees with the domain state machine for every ordered pair of statuses', async () => {
    const rows = await su.query<{ from_status: string; to_status: string; allowed: boolean }>(
      `select f as from_status, t as to_status, core.payment_transition_allowed(f, t) as allowed
         from unnest($1::text[]) f cross join unnest($1::text[]) t`,
      [PAYMENT_STATUSES]
    );
    expect(rows.rows).toHaveLength(49);
    for (const row of rows.rows) {
      const expected = canTransition(
        row.from_status as (typeof PAYMENT_STATUSES)[number],
        row.to_status as (typeof PAYMENT_STATUSES)[number]
      );
      expect(row.allowed, `${row.from_status} -> ${row.to_status}`).toBe(expected);
    }
  });

  it('refuses every illegal transition on both the transaction and the payment', async () => {
    const sources: Record<string, string[]> = {
      created: [],
      requires_action: ['requires_action'],
      processing: ['processing'],
      succeeded: ['processing', 'succeeded'],
      failed: ['processing', 'failed'],
      cancelled: ['cancelled'],
      expired: ['processing', 'expired'],
    };
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (from === to || canTransition(from, to)) continue;
        const pair = await insertPair();
        await advance(pair, ...sources[from]!);
        const completed = ['succeeded', 'failed', 'cancelled', 'expired'].includes(to);
        const set = `status = '${to}'${completed ? ', completed_at = now()' : ''}${
          to === 'succeeded' ? ", provider = 'mtn'" : ''
        }`;
        const onTransaction = await failureOf(rw, [
          [`update core.transactions set ${set} where id = $1`, [pair.transactionId]],
        ]);
        expect(onTransaction?.code, `transaction ${from} -> ${to}`).toBe('23514');
        const onPayment = await failureOf(rw, [
          [`update core.payments set status = '${to}' where id = $1`, [pair.paymentId]],
        ]);
        expect(onPayment?.code, `payment ${from} -> ${to}`).toBe('23514');
      }
    }
  });

  it('refuses any change to a terminal payment, even one that restates its status', async () => {
    for (const path of [
      ['processing', 'succeeded'],
      ['processing', 'failed'],
      ['cancelled'],
      ['processing', 'expired'],
    ]) {
      const pair = await insertPair();
      await advance(pair, ...path);
      for (const [table, id] of [
        ['transactions', pair.transactionId],
        ['payments', pair.paymentId],
      ] as const) {
        const failure = await failureOf(rw, [
          [`update core.${table} set metadata = '{"a":"b"}' where id = $1`, [id]],
        ]);
        expect(failure?.code, `${table} after ${path.join('>')}`).toBe('23514');
        expect(failure?.message).toMatch(/cannot change/);
      }
    }
  });

  it('starts a payment in created and nowhere else', async () => {
    for (const status of ['processing', 'succeeded']) {
      const { statements } = pairStatements({ status });
      const failure = await failureOf(rw, statements);
      expect(failure?.code, status).toBe('23514');
    }
  });
});

describe('a payment and its transaction are one object', () => {
  it('refuses a transaction without a payment at commit', async () => {
    const { statements } = pairStatements();
    const failure = await failureOf(rw, [statements[0]!]);
    expect(failure?.code).toBe('23514');
    expect(failure?.message).toMatch(/has no payment row/);
  });

  it('refuses a status change on one row only', async () => {
    const pair = await insertPair();
    const onlyTransaction = await failureOf(rw, [
      [`update core.transactions set status = 'processing' where id = $1`, [pair.transactionId]],
    ]);
    expect(onlyTransaction?.code).toBe('23514');
    expect(onlyTransaction?.message).toMatch(/disagree/);
    const onlyPayment = await failureOf(rw, [
      [`update core.payments set status = 'processing' where id = $1`, [pair.paymentId]],
    ]);
    expect(onlyPayment?.code).toBe('23514');
    expect(onlyPayment?.message).toMatch(/disagree/);
    // Both together are fine.
    expect(await failureOf(rw, moveBoth(pair, `status = 'processing'`))).toBeNull();
  });

  it('refuses a payment whose amount, currency, merchant or environment differ from its transaction', async () => {
    const cases: Array<[string, (s: Array<[string, unknown[]]>) => void]> = [
      ['amount', (s) => (s[1]![1][5] = '5001')],
      ['currency', (s) => (s[1]![1][6] = 'KES')],
      ['merchant', (s) => (s[1]![1][3] = other.id)],
      ['environment', (s) => (s[1]![1][4] = 'live')],
      ['channel', (s) => (s[1]![1][8] = 'card')],
    ];
    for (const [label, mutate] of cases) {
      const { statements } = pairStatements();
      mutate(statements);
      const failure = await failureOf(rw, statements);
      expect(failure?.code, label).toBe('23514');
    }
  });

  it('refuses a payment that points at a transaction created at another time', async () => {
    const { statements } = pairStatements({ paymentCreatedAt: "now() - interval '1 second'" });
    const failure = await failureOf(rw, statements);
    expect(failure?.code).toBe('23503');
  });
});

describe('what never changes', () => {
  it('refuses a change to amount, currency, merchant, environment, channel or reference', async () => {
    const pair = await insertPair();
    for (const set of [
      'amount_minor = 6000, net_minor = 6000',
      `currency = 'KES'`,
      `merchant_id = '${other.id}'`,
      `environment = 'live'`,
      `channel = 'card'`,
      `ref = 'txn_00000000000000000000000000'`,
      `gateway_external_id = 'pay_00000000000000000000000000'`,
    ]) {
      const failure = await failureOf(rw, [
        [`update core.transactions set ${set} where id = $1`, [pair.transactionId]],
      ]);
      expect(failure?.code, set).toBe('23514');
    }
    for (const set of [
      'amount_minor = 6000',
      `currency = 'KES'`,
      `merchant_id = '${other.id}'`,
      `idempotency_key = 'other'`,
      `expires_at = now() + interval '1 day'`,
      `transaction_id = '${randomUUID()}'`,
    ]) {
      const failure = await failureOf(rw, [
        [`update core.payments set ${set} where id = $1`, [pair.paymentId]],
      ]);
      expect(failure?.code, set).toBeTruthy();
    }
  });

  it('sets the provider and gateway identifiers once', async () => {
    const pair = await insertPair();
    const set = `provider = 'mtn', gateway_operation_id = '${randomUUID()}', gateway_reference_id = 'ref-1', provider_transaction_id = 'ptx-1'`;
    expect(
      await failureOf(rw, [
        [`update core.transactions set ${set} where id = $1`, [pair.transactionId]],
      ])
    ).toBeNull();
    // Setting the same value again is allowed (a repeated event); changing it is not.
    expect(
      await failureOf(rw, [
        [
          `update core.transactions set provider = 'mtn', gateway_reference_id = 'ref-1' where id = $1`,
          [pair.transactionId],
        ],
      ])
    ).toBeNull();
    for (const change of [
      `provider = 'airtel'`,
      `gateway_operation_id = '${randomUUID()}'`,
      `gateway_reference_id = 'ref-2'`,
      `provider_transaction_id = 'ptx-2'`,
      `provider = null`,
    ]) {
      const failure = await failureOf(rw, [
        [`update core.transactions set ${change} where id = $1`, [pair.transactionId]],
      ]);
      expect(failure?.code, change).toBe('23514');
    }
  });

  it('never deletes or truncates financial records, as the application role or as the superuser', async () => {
    const pair = await insertPair();
    for (const [table, id] of [
      ['transactions', pair.transactionId],
      ['payments', pair.paymentId],
    ] as const) {
      expect((await failureOf(rw, [[`delete from core.${table} where id = $1`, [id]]]))?.code).toBe(
        '42501'
      );
      expect((await failureOf(su, [[`delete from core.${table} where id = $1`, [id]]]))?.code).toBe(
        '42501'
      );
    }
    // TRUNCATE takes an exclusive lock before it checks anything, which would stall and could
    // deadlock the suites running beside this one, so it is proven from the catalog: the role
    // holds no TRUNCATE privilege, and a BEFORE TRUNCATE trigger refuses it for everyone else.
    const tables = ['transactions', 'payments', 'payment_links', 'checkout_sessions'];
    for (const table of tables) {
      const privilege = await su.query<{ allowed: boolean }>(
        `select has_table_privilege('mulapay_core_rw', $1, 'TRUNCATE') as allowed`,
        [`core.${table}`]
      );
      expect(privilege.rows[0]?.allowed, table).toBe(false);
      const triggers = await su.query<{ n: number }>(
        `select count(*)::int as n from pg_trigger
          where tgrelid = $1::regclass and not tgisinternal
            and (tgtype & 32) = 32 and tgfoid = 'core.reject_mutation'::regproc`,
        [`core.${table}`]
      );
      expect(triggers.rows[0]?.n, `${table} BEFORE TRUNCATE trigger`).toBe(1);
    }
    // Nor directly on a partition, where the parent's trigger does not run.
    const partitions = await su.query<{ relname: string }>(
      `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'core.transactions'::regclass`
    );
    expect(partitions.rows.length).toBeGreaterThanOrEqual(5);
    for (const { relname } of partitions.rows) {
      const privilege = await su.query<{ allowed: boolean; deletes: boolean }>(
        `select has_table_privilege('mulapay_core_rw', $1, 'TRUNCATE') as allowed,
                has_table_privilege('mulapay_core_rw', $1, 'DELETE') as deletes`,
        [`core.${relname}`]
      );
      expect(privilege.rows[0], relname).toEqual({ allowed: false, deletes: false });
    }
  });
});

describe('value rules', () => {
  it('keeps the outcome flag to processing payments', async () => {
    const pair = await insertPair();
    expect(
      (
        await failureOf(rw, [
          [
            `update core.transactions set outcome_unknown = true where id = $1`,
            [pair.transactionId],
          ],
        ])
      )?.code
    ).toBe('23514');
    await advance(pair, 'processing');
    expect(
      await failureOf(rw, [
        [`update core.transactions set outcome_unknown = true where id = $1`, [pair.transactionId]],
      ])
    ).toBeNull();
    // Leaving processing without clearing the flag is refused.
    const stuck = await failureOf(rw, [
      [
        `update core.transactions set status = 'failed', failure_code = 'declined', completed_at = now() where id = $1`,
        [pair.transactionId],
      ],
      [`update core.payments set status = 'failed' where id = $1`, [pair.paymentId]],
    ]);
    expect(stuck?.code).toBe('23514');
    expect(
      await failureOf(rw, [
        [
          `update core.transactions set status = 'failed', outcome_unknown = false, failure_code = 'declined', completed_at = now() where id = $1`,
          [pair.transactionId],
        ],
        [`update core.payments set status = 'failed' where id = $1`, [pair.paymentId]],
      ])
    ).toBeNull();
  });

  it('sets completed_at exactly when the status is terminal', async () => {
    const pair = await insertPair();
    expect(
      (
        await failureOf(rw, [
          [`update core.transactions set completed_at = now() where id = $1`, [pair.transactionId]],
        ])
      )?.code
    ).toBe('23514');
    await advance(pair, 'processing');
    const noStamp = await failureOf(rw, [
      [`update core.transactions set status = 'expired' where id = $1`, [pair.transactionId]],
      [`update core.payments set status = 'expired' where id = $1`, [pair.paymentId]],
    ]);
    expect(noStamp?.code).toBe('23514');
  });

  it('records a success only with a known provider', async () => {
    const pair = await insertPair();
    await advance(pair, 'processing');
    const failure = await failureOf(rw, [
      [
        `update core.transactions set status = 'succeeded', completed_at = now() where id = $1`,
        [pair.transactionId],
      ],
      [`update core.payments set status = 'succeeded' where id = $1`, [pair.paymentId]],
    ]);
    expect(failure?.code).toBe('23514');
    expect(failure?.message).toMatch(/success_provider/);
  });

  it('keeps failure codes well formed and to unsuccessful endings', async () => {
    const pair = await insertPair();
    for (const set of [`failure_code = 'declined'`, `failure_reason = 'x'`]) {
      expect(
        (
          await failureOf(rw, [
            [`update core.transactions set ${set} where id = $1`, [pair.transactionId]],
          ])
        )?.code,
        set
      ).toBe('23514');
    }
    await advance(pair, 'processing');
    const bad = await failureOf(rw, [
      [
        `update core.transactions set status = 'failed', failure_code = 'Bad Code', completed_at = now() where id = $1`,
        [pair.transactionId],
      ],
      [`update core.payments set status = 'failed' where id = $1`, [pair.paymentId]],
    ]);
    expect(bad?.code).toBe('23514');
  });

  it('keeps amounts positive and fee and net consistent', async () => {
    for (const [amount, fee, net] of [
      ['0', '0', '0'],
      ['-5', '0', '-5'],
      ['100', '101', '-1'],
      ['100', '10', '91'],
      ['100', '-1', '101'],
    ]) {
      const { statements } = pairStatements();
      statements[0]![1][5] = amount;
      statements[0]![0] = statements[0]![0].replace('0, $6,', `${fee}, ${net},`);
      const failure = await failureOf(rw, [statements[0]!]);
      expect(failure?.code, `${amount}/${fee}/${net}`).toBe('23514');
    }
  });

  it('refuses an unsupported currency, an unknown channel and an unknown status', async () => {
    expect((await failureOf(rw, pairStatements({ currency: 'XXX' }).statements))?.code).toBe(
      '23503'
    );
    expect((await failureOf(rw, pairStatements({ channel: 'cash' }).statements))?.code).toBe(
      '23514'
    );
    expect((await failureOf(rw, pairStatements({ status: 'unknown' }).statements))?.code).toBe(
      '23514'
    );
    expect((await failureOf(rw, pairStatements({ status: 'successful' }).statements))?.code).toBe(
      '23514'
    );
  });
});

describe('uniqueness across partitions', () => {
  it('keeps the transaction ref unique through the registry', async () => {
    const first = await insertPair();
    const { statements } = pairStatements();
    statements[0]![1][1] = first.transactionRef;
    const failure = await failureOf(rw, statements);
    expect(failure?.code).toBe('23505');
    expect(failure?.message).toMatch(/transaction_keys_ref_key/);
  });

  it('keeps a gateway external id to one transaction per operation type', async () => {
    const first = await insertPair();
    const { statements } = pairStatements({ externalId: first.paymentRef });
    const failure = await failureOf(rw, statements);
    expect(failure?.code).toBe('23505');
    expect(failure?.message).toMatch(/transaction_keys_type_external_id_key/);
  });

  it('keeps one payment per transaction and one idempotency key per merchant and environment', async () => {
    const first = await insertPair({ idempotencyKey: 'dup-key' });
    const sameKey = await failureOf(rw, pairStatements({ idempotencyKey: 'dup-key' }).statements);
    expect(sameKey?.code).toBe('23505');
    expect(sameKey?.message).toMatch(/payments_idempotency_key_key/);
    // Another merchant, or the other environment, may use the same key.
    expect(
      await failureOf(
        rw,
        pairStatements({ idempotencyKey: 'dup-key', merchantId: other.id }).statements
      )
    ).toBeNull();
    expect(
      await failureOf(
        rw,
        pairStatements({ idempotencyKey: 'dup-key', environment: 'live' }).statements
      )
    ).toBeNull();
    const second = pairStatements();
    second.statements[1]![1][2] = first.transactionId;
    expect(
      (await failureOf(rw, [second.statements[0]!, second.statements[1]!]))?.code
    ).toBeTruthy();
  });

  it('writes the registry only from a transaction insert and never changes it', async () => {
    const pair = await insertPair();
    const direct = await failureOf(rw, [
      [
        `insert into core.transaction_keys (id, ref, transaction_created_at, merchant_id, environment, type)
         values ($1, 'txn_00000000000000000000000001', now(), $2, 'test', 'payment')`,
        [randomUUID(), merchant.id],
      ],
    ]);
    expect(direct?.code).toBe('42501');
    for (const text of [
      `update core.transaction_keys set ref = 'x' where id = $1`,
      `delete from core.transaction_keys where id = $1`,
    ]) {
      expect((await failureOf(rw, [[text, [pair.transactionId]]]))?.code, text).toBe('42501');
      expect((await failureOf(su, [[text, [pair.transactionId]]]))?.code, text).toBe('42501');
    }
    expect(
      (
        await su.query<{ allowed: boolean }>(
          `select has_table_privilege('mulapay_core_rw', 'core.transaction_keys', 'TRUNCATE') as allowed`
        )
      ).rows[0]?.allowed
    ).toBe(false);
  });
});

describe('the transaction event log', () => {
  async function eventInsert(pair: Pair, overrides: Record<string, unknown> = {}) {
    const values = {
      key: `k-${randomUUID()}`,
      merchant: merchant.id,
      environment: 'test',
      outcome: 'applied',
      reason: null,
      from: 'created',
      to: 'processing',
      ...overrides,
    };
    return failureOf(rw, [
      [
        `insert into core.transaction_events (id, transaction_id, merchant_id, environment, event_key, source, outcome, from_status, to_status, rejection_reason, occurred_at)
         values ($1, $2, $3, $4, $5, 'gateway_event', $6, $7, $8, $9, now())`,
        [
          randomUUID(),
          pair.transactionId,
          values.merchant,
          values.environment,
          values.key,
          values.outcome,
          values.from,
          values.to,
          values.reason,
        ],
      ],
    ]);
  }

  it('records an event once per key, and only for the transaction’s own merchant and environment', async () => {
    const pair = await insertPair();
    expect(await eventInsert(pair, { key: 'same' })).toBeNull();
    expect((await eventInsert(pair, { key: 'same' }))?.code).toBe('23505');
    expect((await eventInsert(pair, { merchant: other.id }))?.code).toBe('23514');
    expect((await eventInsert(pair, { environment: 'live' }))?.code).toBe('23514');
  });

  it('has a reason exactly when the event was refused', async () => {
    const pair = await insertPair();
    expect((await eventInsert(pair, { outcome: 'rejected' }))?.code).toBe('23514');
    expect((await eventInsert(pair, { outcome: 'applied', reason: 'terminal_state' }))?.code).toBe(
      '23514'
    );
    expect(await eventInsert(pair, { outcome: 'rejected', reason: 'terminal_state' })).toBeNull();
    expect((await eventInsert(pair, { to: 'unknown' }))?.code).toBe('23514');
  });

  it('is append-only', async () => {
    const pair = await insertPair();
    await eventInsert(pair, { key: 'once' });
    for (const text of [
      `update core.transaction_events set outcome = 'noop' where transaction_id = $1`,
      `delete from core.transaction_events where transaction_id = $1`,
    ]) {
      expect((await failureOf(rw, [[text, [pair.transactionId]]]))?.code, text).toBe('42501');
      expect((await failureOf(su, [[text, [pair.transactionId]]]))?.code, text).toBe('42501');
    }
    expect(
      (
        await su.query<{ allowed: boolean }>(
          `select has_table_privilege('mulapay_core_rw', 'core.transaction_events', 'TRUNCATE') as allowed`
        )
      ).rows[0]?.allowed
    ).toBe(false);
  });
});

describe('partitioning', () => {
  /** Partition scans in an analysed plan that actually ran. */
  async function executedPartitions(sqlText: string, values: unknown[]): Promise<string[]> {
    const plan = await su.query<{ 'QUERY PLAN': string }>(sqlText, values);
    return plan.rows
      .map((r) => r['QUERY PLAN'])
      .filter((line) => /on transactions_\w+/.test(line) && !line.includes('never executed'))
      .map((line) => /on (transactions_\w+)/.exec(line)?.[1] ?? '');
  }

  it('partitions transactions by month on created_at', async () => {
    const [kind] = (
      await su.query<{ relkind: string; strategy: string }>(
        `select c.relkind, p.partstrat as strategy from pg_class c join pg_partitioned_table p on p.partrelid = c.oid
          where c.oid = 'core.transactions'::regclass`
      )
    ).rows;
    expect(kind).toEqual({ relkind: 'p', strategy: 'r' });
  });

  it('reads one partition for a lookup by public ref', async () => {
    const pair = await insertPair();
    const executed = await executedPartitions(
      `explain (analyze, costs off, timing off, summary off)
       select t.* from core.transaction_keys k
         join core.transactions t on t.id = k.id and t.created_at = k.transaction_created_at
        where k.ref = $1`,
      [pair.transactionRef]
    );
    expect(new Set(executed).size).toBe(1);
  });

  it('prunes a windowed list to the partitions in range', async () => {
    const executed = await executedPartitions(
      `explain (analyze, costs off, timing off, summary off)
       select * from core.transactions
        where merchant_id = $1 and environment = 'test'
          and created_at >= now() - interval '1 day' and created_at <= now()`,
      [merchant.id]
    );
    expect(new Set(executed).size).toBeGreaterThanOrEqual(1);
    expect(new Set(executed).size).toBeLessThanOrEqual(2);
    expect(executed).not.toContain('transactions_default');
  });

  it('has a default partition and a partition for the current month', async () => {
    const names = (
      await su.query<{ relname: string }>(
        `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'core.transactions'::regclass`
      )
    ).rows.map((r) => r.relname);
    expect(names).toContain('transactions_default');
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    expect(names).toContain(`transactions_${month}`);
  });
});

describe('payment links', () => {
  async function insertLink(extra = '', values: unknown[] = []) {
    const id = randomUUID();
    const failure = await failureOf(rw, [
      [
        `insert into core.payment_links (id, ref, merchant_id, environment, amount_minor, currency, title, slug, max_uses, used_count, created_at)
         values ($1, core.gen_public_id('pl'), $2, 'test', 1000, 'UGX', 'title', $3, ${extra || 'null, 0'}, now())`,
        [id, merchant.id, randomUUID().replace(/-/g, '').slice(0, 12), ...values],
      ],
    ]);
    return { id, failure };
  }

  it('refuses a use count past max_uses or below zero, and a malformed slug', async () => {
    expect((await insertLink('2, 3')).failure?.code).toBe('23514');
    expect((await insertLink('2, -1')).failure?.code).toBe('23514');
    expect((await insertLink('0, 0')).failure?.code).toBe('23514');
    expect((await insertLink('2, 2')).failure).toBeNull();
    const bad = await failureOf(rw, [
      [
        `insert into core.payment_links (id, ref, merchant_id, environment, currency, title, slug)
         values ($1, core.gen_public_id('pl'), $2, 'test', 'UGX', 't', 'BAD SLUG')`,
        [randomUUID(), merchant.id],
      ],
    ]);
    expect(bad?.code).toBe('23514');
  });

  it('never lowers used_count and never changes the terms of a link', async () => {
    const { id } = await insertLink('5, 2');
    expect(
      (await failureOf(rw, [[`update core.payment_links set used_count = 1 where id = $1`, [id]]]))
        ?.code
    ).toBe('23514');
    for (const set of [
      'amount_minor = 2000',
      `currency = 'KES'`,
      `slug = 'abcdefghijkl'`,
      `merchant_id = '${other.id}'`,
    ]) {
      expect(
        (await failureOf(rw, [[`update core.payment_links set ${set} where id = $1`, [id]]]))?.code,
        set
      ).toBe('23514');
    }
    expect(
      await failureOf(rw, [
        [
          `update core.payment_links set used_count = 3, title = 'new', active = false where id = $1`,
          [id],
        ],
      ])
    ).toBeNull();
  });
});

describe('checkout sessions', () => {
  async function insertSession(): Promise<string> {
    const id = randomUUID();
    const failure = await failureOf(rw, [
      [
        `insert into core.checkout_sessions (id, ref, merchant_id, environment, amount_minor, currency, expires_at, client_secret_hash, created_at)
         values ($1, core.gen_public_id('cs'), $2, 'test', 1000, 'UGX', now() + interval '1 day', repeat('a', 64), now())`,
        [id, merchant.id],
      ],
    ]);
    if (failure) throw new Error(failure.message);
    return id;
  }

  it('moves from open to complete or expired once, and then never again', async () => {
    const pair = await insertPair();
    const id = await insertSession();
    // A completed session must name its payment and be stamped.
    expect(
      (
        await failureOf(rw, [
          [`update core.checkout_sessions set status = 'complete' where id = $1`, [id]],
        ])
      )?.code
    ).toBe('23514');
    expect(
      await failureOf(rw, [
        [
          `update core.checkout_sessions set status = 'complete', completed_at = now(), payment_id = $2 where id = $1`,
          [id, pair.paymentId],
        ],
      ])
    ).toBeNull();
    for (const set of [
      `status = 'expired', completed_at = null`,
      `status = 'open', completed_at = null`,
      `title = 1`,
    ]) {
      const failure = await failureOf(rw, [
        [`update core.checkout_sessions set ${set} where id = $1`, [id]],
      ]);
      expect(failure?.code, set).toBeTruthy();
    }
    const expired = await insertSession();
    expect(
      await failureOf(rw, [
        [`update core.checkout_sessions set status = 'expired' where id = $1`, [expired]],
      ])
    ).toBeNull();
    expect(
      (
        await failureOf(rw, [
          [`update core.checkout_sessions set status = 'open' where id = $1`, [expired]],
        ])
      )?.code
    ).toBe('23514');
  });

  it('sets its payment once, and never changes its amount, currency, secret or expiry', async () => {
    const first = await insertPair();
    const second = await insertPair();
    const id = await insertSession();
    expect(
      await failureOf(rw, [
        [`update core.checkout_sessions set payment_id = $2 where id = $1`, [id, first.paymentId]],
      ])
    ).toBeNull();
    expect(
      (
        await failureOf(rw, [
          [
            `update core.checkout_sessions set payment_id = $2 where id = $1`,
            [id, second.paymentId],
          ],
        ])
      )?.code
    ).toBe('23514');
    const other = await insertSession();
    // One payment belongs to at most one session.
    expect(
      (
        await failureOf(rw, [
          [
            `update core.checkout_sessions set payment_id = $2 where id = $1`,
            [other, first.paymentId],
          ],
        ])
      )?.code
    ).toBe('23505');
    for (const set of [
      'amount_minor = 2000',
      `currency = 'KES'`,
      `client_secret_hash = repeat('b', 64)`,
      `expires_at = now()`,
    ]) {
      expect(
        (await failureOf(rw, [[`update core.checkout_sessions set ${set} where id = $1`, [other]]]))
          ?.code,
        set
      ).toBe('23514');
    }
  });

  it('is never deleted', async () => {
    const id = await insertSession();
    expect(
      (await failureOf(rw, [[`delete from core.checkout_sessions where id = $1`, [id]]]))?.code
    ).toBe('42501');
    expect(
      (await failureOf(su, [[`delete from core.checkout_sessions where id = $1`, [id]]]))?.code
    ).toBe('42501');
  });

  it('keeps a payment to one origin', async () => {
    const link = randomUUID();
    const session = await insertSession();
    await rw.query(
      `insert into core.payment_links (id, ref, merchant_id, environment, currency, title, slug, created_at)
       values ($1, core.gen_public_id('pl'), $2, 'test', 'UGX', 't', $3, now())`,
      [link, merchant.id, randomUUID().replace(/-/g, '').slice(0, 12)]
    );
    const { statements } = pairStatements();
    statements[1]![0] = statements[1]![0]
      .replace(
        'expires_at, created_at)',
        `expires_at, payment_link_id, checkout_session_id, created_at)`
      )
      .replace(
        "now() + interval '15 minutes', now())",
        `now() + interval '15 minutes', '${link}', '${session}', now())`
      );
    expect((await failureOf(rw, statements))?.code).toBe('23514');
  });
});

describe('idempotency records', () => {
  it('needs a stored response for a completed record', async () => {
    const failure = await failureOf(rw, [
      [
        `insert into core.idempotency_keys (id, merchant_id, environment, scope, key, request_fingerprint, status, locked_at, expires_at)
         values ($1, $2, 'test', 'payments.create', $3, repeat('a', 64), 'completed', now(), now() + interval '1 day')`,
        [randomUUID(), merchant.id, `k-${randomUUID()}`],
      ],
    ]);
    expect(failure?.code).toBe('23514');
  });

  it('is unique per merchant, environment, operation and key', async () => {
    const key = `k-${randomUUID()}`;
    const insert = (
      merchantId: string,
      environment: string,
      scope: string
    ): [string, unknown[]] => [
      `insert into core.idempotency_keys (id, merchant_id, environment, scope, key, request_fingerprint, status, locked_at, expires_at)
       values ($1, $2, $3, $4, $5, repeat('a', 64), 'in_flight', now(), now() + interval '1 day')`,
      [randomUUID(), merchantId, environment, scope, key],
    ];
    expect(await failureOf(rw, [insert(merchant.id, 'test', 'payments.create')])).toBeNull();
    expect((await failureOf(rw, [insert(merchant.id, 'test', 'payments.create')]))?.code).toBe(
      '23505'
    );
    expect(await failureOf(rw, [insert(merchant.id, 'live', 'payments.create')])).toBeNull();
    expect(await failureOf(rw, [insert(other.id, 'test', 'payments.create')])).toBeNull();
    expect(await failureOf(rw, [insert(merchant.id, 'test', 'payment_links.create')])).toBeNull();
  });
});

describe('permissions for the dashboard reads', () => {
  it('grants payments:read and transactions:read to the merchant roles', async () => {
    const rows = await su.query<{ role_key: string; permission_key: string }>(
      `select role_key, permission_key from core.role_permissions
        where permission_key in ('payments:read', 'transactions:read')`
    );
    // `viewer` is left out: the admin suite edits that seeded role while this one runs, so
    // its grants are checked in the migration seed by the other roles' identical rows.
    for (const role of ['owner', 'admin', 'developer', 'finance', 'support']) {
      for (const permission of ['payments:read', 'transactions:read']) {
        expect(rows.rows, `${role} ${permission}`).toContainEqual({
          role_key: role,
          permission_key: permission,
        });
      }
    }
    const permissions = await su.query<{ key: string; actor_type: string }>(
      `select key, actor_type from core.permissions where key in ('payments:read', 'transactions:read')`
    );
    expect(permissions.rows.map((r) => r.actor_type)).toEqual(['merchant', 'merchant']);
  });
});
