/**
 * Phase 2 exit criterion: every ledger invariant is enforced by Postgres itself, proven
 * by a test that tries to violate it with plain SQL as mulapay_core_rw (bypassing the
 * services) and expects an error. Where a trigger backs a revoked privilege, the
 * superuser (which ignores privileges) proves the trigger too.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicId } from '../../src/common/ids/ids';
import {
  connect,
  createBankAccount,
  createMerchant,
  startLedgerContext,
  type LedgerContext,
  type TestMerchant,
} from '../support/ledger';

let ctx: LedgerContext;
let rw: Client;
let su: Client;
let merchant: TestMerchant;
let otherMerchant: TestMerchant;
const ids: Record<string, string> = {};

const TRUNCATES = [
  'truncate core.journal_entries cascade',
  'truncate core.journal_lines cascade',
  'truncate core.journal_entry_keys cascade',
];

const hex = (value: string) => createHash('sha256').update(value).digest('hex');

async function accountId(environment: string, code: string): Promise<string> {
  const result = await rw.query<{ id: string }>(
    'select id from core.accounts where environment = $1 and code = $2',
    [environment, code]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`no account ${environment} ${code}`);
  return id;
}

interface EntryOptions {
  id?: string;
  ref?: string;
  key?: string;
  environment?: string;
  currency?: string;
  merchantId?: string | null;
  source?: string;
  reverses?: string | null;
  createdAt?: string;
}

/** Inserts an entry row the way the repository does; returns its id. */
async function insertEntry(client: Client, options: EntryOptions = {}): Promise<string> {
  const id = options.id ?? randomUUID();
  // created_at is normally left to its default; the dated variant proves it is refused.
  const sql = options.createdAt
    ? `insert into core.journal_entries
         (id, ref, idempotency_key, request_fingerprint, environment, merchant_id, currency, kind,
          description, source, source_id, reverses_entry_id, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'test', 'schema test', $8, $9, $10, 'system:schema-test', $11)`
    : `insert into core.journal_entries
         (id, ref, idempotency_key, request_fingerprint, environment, merchant_id, currency, kind,
          description, source, source_id, reverses_entry_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'test', 'schema test', $8, $9, $10, 'system:schema-test')`;
  await client.query(sql, [
    id,
    options.ref ?? publicId('journalEntry'),
    options.key ?? hex(randomUUID()),
    hex('fingerprint'),
    options.environment ?? 'test',
    options.merchantId ?? null,
    options.currency ?? 'UGX',
    options.source ?? (options.reverses ? 'reversal' : 'adjustment'),
    randomUUID(),
    options.reverses ?? null,
    ...(options.createdAt ? [options.createdAt] : []),
  ]);
  return id;
}

async function insertLine(
  client: Client,
  entryId: string,
  lineNo: number,
  account: string,
  direction: string,
  amount: string | number,
  currency = 'UGX'
): Promise<void> {
  await client.query(
    `insert into core.journal_lines (entry_id, line_no, account_id, direction, amount_minor, currency)
     values ($1, $2, $3, $4, $5, $6)`,
    [entryId, lineNo, account, direction, amount, currency]
  );
}

/** Runs `work` in a transaction and returns the error raised by it or by COMMIT. */
async function failure(work: (client: Client) => Promise<void>, client = rw) {
  await client.query('begin');
  try {
    await work(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    return error as { code: string; message: string };
  }
  throw new Error('expected the transaction to fail');
}

async function commit(work: (client: Client) => Promise<void>, client = rw): Promise<void> {
  await client.query('begin');
  try {
    await work(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** A committed, balanced two-line entry between ids.bankA and ids.bankB. */
async function balancedEntry(amount = 100): Promise<string> {
  let id = '';
  await commit(async (c) => {
    id = await insertEntry(c);
    await insertLine(c, id, 1, ids.bankA as string, 'debit', amount);
    await insertLine(c, id, 2, ids.bankB as string, 'credit', amount);
  });
  return id;
}

beforeAll(async () => {
  ctx = await startLedgerContext();
  rw = await connect('rw');
  su = await connect('superuser');
  merchant = await createMerchant(ctx);
  otherMerchant = await createMerchant(ctx);
  ids.bankA = await accountId('test', await createBankAccount(ctx));
  ids.bankB = await accountId('test', await createBankAccount(ctx));
  ids.bankKes = await accountId('test', await createBankAccount(ctx, 'test', 'KES'));
  ids.liveBank = await accountId('live', await createBankAccount(ctx, 'live'));
  ids.payable = await accountId('test', merchant.payable);
  ids.otherPayable = await accountId('test', otherMerchant.payable);
});

afterAll(async () => {
  await rw?.end();
  await su?.end();
  await ctx?.close();
});

describe('financial amounts are bigint minor units', () => {
  it('stores every amount column as bigint', async () => {
    const result = await rw.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'core' and column_name like '%\\_minor' and table_name not like '%\\_20%' and table_name not like '%\\_default'`
    );
    expect(result.rows.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual([
      'account_balances.posted_credits_minor',
      'account_balances.posted_debits_minor',
      'checkout_sessions.amount_minor',
      'journal_lines.amount_minor',
      'payment_links.amount_minor',
      'payments.amount_minor',
      'transactions.amount_minor',
      'transactions.fee_minor',
      'transactions.net_minor',
    ]);
    expect(result.rows.every((r) => r.data_type === 'bigint')).toBe(true);
  });

  it('refuses fractional, zero and negative amounts', async () => {
    for (const [amount, code] of [
      ['1.5', '22P02'],
      ['0', '23514'],
      ['-100', '23514'],
      ['9223372036854775808', '22003'],
    ] as const) {
      const error = await failure(async (c) => {
        const id = await insertEntry(c);
        await insertLine(c, id, 1, ids.bankA as string, 'debit', amount);
      });
      expect(error.code, amount).toBe(code);
    }
  });
});

describe('debit and credit totals must balance (deferred constraint trigger)', () => {
  it('refuses an unbalanced entry at commit', async () => {
    const error = await failure(async (c) => {
      const id = await insertEntry(c);
      await insertLine(c, id, 1, ids.bankA as string, 'debit', 100);
      await insertLine(c, id, 2, ids.bankB as string, 'credit', 99);
    });
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/is unbalanced: debits 100 <> credits 99/);
  });

  it('refuses entries with one line or no lines', async () => {
    const one = await failure(async (c) => {
      const id = await insertEntry(c);
      await insertLine(c, id, 1, ids.bankA as string, 'debit', 100);
    });
    expect(one.message).toMatch(/has 1 line\(s\); at least two are required/);
    const none = await failure(async (c) => {
      await insertEntry(c);
    });
    expect(none.message).toMatch(/has 0 line\(s\)/);
  });

  it('refuses unbalanced entries even when the check is made immediate', async () => {
    const error = await failure(async (c) => {
      await c.query('set constraints all immediate');
      await insertEntry(c);
    });
    expect(error.code).toBe('23514');
  });

  it('refuses adding lines to an entry committed earlier, even balanced ones', async () => {
    const id = await balancedEntry();
    const error = await failure(async (c) => {
      const createdAt = await c.query<{ created_at: string }>(
        'select created_at::text from core.journal_entries where id = $1',
        [id]
      );
      await c.query(
        `insert into core.journal_lines (entry_id, line_no, account_id, direction, amount_minor, currency, created_at)
         values ($1, 3, $2, 'debit', 5, 'UGX', $3)`,
        [id, ids.bankA, createdAt.rows[0]?.created_at]
      );
    });
    expect(error.code).toBe('23514');
    expect(error.message).toMatch(/created_at is set by the database/);
    const sameTimestamp = await failure(async (c) => {
      await insertLine(c, id, 3, ids.bankA as string, 'debit', 5);
      await insertLine(c, id, 4, ids.bankB as string, 'credit', 5);
    });
    expect(sameTimestamp.message).toMatch(/inserted in the transaction that creates their entry/);
  });

  it('accepts a balanced entry and applies it to account_balances in the same transaction', async () => {
    const before = await rw.query(
      `select account_id, posted_debits_minor, posted_credits_minor from core.account_balances
        where account_id = any($1) and currency = 'UGX'`,
      [[ids.bankA, ids.bankB]]
    );
    const read = (rows: typeof before.rows, id: string, column: string) =>
      BigInt(rows.find((r) => r.account_id === id)?.[column] ?? 0);
    await balancedEntry(321);
    const after = await rw.query(
      `select account_id, posted_debits_minor, posted_credits_minor from core.account_balances
        where account_id = any($1) and currency = 'UGX'`,
      [[ids.bankA, ids.bankB]]
    );
    expect(read(after.rows, ids.bankA as string, 'posted_debits_minor')).toBe(
      read(before.rows, ids.bankA as string, 'posted_debits_minor') + 321n
    );
    expect(read(after.rows, ids.bankB as string, 'posted_credits_minor')).toBe(
      read(before.rows, ids.bankB as string, 'posted_credits_minor') + 321n
    );
  });
});

describe('each line is checked against its entry and account', () => {
  it('refuses a line in another currency than the entry', async () => {
    const error = await failure(async (c) => {
      const id = await insertEntry(c);
      await insertLine(c, id, 1, ids.bankA as string, 'debit', 100, 'KES');
    });
    expect(error.message).toMatch(/line currency KES differs from entry currency UGX/);
  });

  it('refuses an account that holds another currency', async () => {
    const error = await failure(async (c) => {
      const id = await insertEntry(c);
      await insertLine(c, id, 1, ids.bankKes as string, 'debit', 100);
    });
    expect(error.message).toMatch(/only holds KES/);
  });

  it('refuses a live account in a test entry (test data never touches live accounts)', async () => {
    const error = await failure(async (c) => {
      const id = await insertEntry(c);
      await insertLine(c, id, 1, ids.liveBank as string, 'debit', 100);
    });
    expect(error.message).toMatch(/belongs to the live environment, the entry to test/);
  });

  it("refuses a merchant account outside that merchant's entries", async () => {
    for (const merchantId of [null, otherMerchant.id]) {
      const error = await failure(async (c) => {
        const id = await insertEntry(c, { merchantId });
        await insertLine(c, id, 1, ids.payable as string, 'credit', 100);
      });
      expect(error.message).toMatch(/belongs to another merchant than the entry/);
    }
  });

  it('refuses an inactive account', async () => {
    const inactive = await accountId('test', await createBankAccount(ctx));
    await rw.query('update core.accounts set active = false where id = $1', [inactive]);
    const error = await failure(async (c) => {
      const id = await insertEntry(c);
      await insertLine(c, id, 1, inactive, 'debit', 100);
    });
    expect(error.message).toMatch(/is inactive/);
  });

  it('refuses unknown accounts and currencies', async () => {
    const account = await failure(async (c) => {
      const id = await insertEntry(c);
      await insertLine(c, id, 1, randomUUID(), 'debit', 100);
    });
    expect(account.code).toBe('23503');
    const currency = await failure(async (c) => {
      await insertEntry(c, { currency: 'CHF' });
    });
    expect(currency.code).toBe('23503');
  });

  it('sets merchant_id on lines from the account, whatever the caller sends', async () => {
    let id = '';
    await commit(async (c) => {
      id = await insertEntry(c, { merchantId: merchant.id });
      await c.query(
        `insert into core.journal_lines (entry_id, line_no, account_id, direction, amount_minor, currency, merchant_id)
         values ($1, 1, $2, 'debit', 10, 'UGX', $3), ($1, 2, $4, 'credit', 10, 'UGX', null)`,
        [id, ids.bankA, otherMerchant.id, ids.payable]
      );
    });
    const lines = await rw.query(
      'select line_no, merchant_id from core.journal_lines where entry_id = $1 order by line_no',
      [id]
    );
    expect(lines.rows).toEqual([
      { line_no: 1, merchant_id: null },
      { line_no: 2, merchant_id: merchant.id },
    ]);
  });
});

describe('entries carry database time and a globally unique key', () => {
  it('refuses back-dated or forward-dated entries', async () => {
    for (const createdAt of ['2025-01-15T00:00:00Z', new Date(Date.now() + 1000).toISOString()]) {
      const error = await failure(async (c) => {
        await insertEntry(c, { createdAt });
      });
      expect(error.message).toMatch(/set by the database/);
    }
  });

  it('refuses a second entry with the same idempotency key or ref', async () => {
    const key = hex(randomUUID());
    const ref = publicId('journalEntry');
    await commit(async (c) => {
      const id = await insertEntry(c, { key, ref });
      await insertLine(c, id, 1, ids.bankA as string, 'debit', 1);
      await insertLine(c, id, 2, ids.bankB as string, 'credit', 1);
    });
    const sameKey = await failure(async (c) => {
      await insertEntry(c, { key });
    });
    expect(sameKey.code).toBe('23505');
    const sameRef = await failure(async (c) => {
      await insertEntry(c, { ref });
    });
    expect(sameRef.code).toBe('23505');
  });

  it('refuses writing the key registry directly', async () => {
    const error = await failure(async (c) => {
      await c.query(
        `insert into core.journal_entry_keys (idempotency_key, entry_id, entry_ref, entry_created_at, request_fingerprint)
         values ($1, $2, $3, now(), $1)`,
        [hex(randomUUID()), randomUUID(), publicId('journalEntry')]
      );
    });
    expect(error.code).toBe('42501');
  });

  it('refuses malformed keys, sources and actors', async () => {
    for (const options of [{ key: 'not-a-sha256' }, { source: 'gift' }, { source: 'reversal' }]) {
      const error = await failure(async (c) => {
        await insertEntry(c, options);
      });
      expect(error.code, JSON.stringify(options)).toBe('23514');
    }
  });
});

describe('posted entries are immutable and cannot be deleted', () => {
  let entryId: string;
  beforeAll(async () => {
    entryId = await balancedEntry(7);
  });

  it('refuses UPDATE, DELETE and TRUNCATE as mulapay_core_rw', async () => {
    for (const sql of [
      `update core.journal_entries set description = 'changed' where id = $1`,
      'update core.journal_lines set amount_minor = 8 where entry_id = $1',
      'delete from core.journal_lines where entry_id = $1',
      'delete from core.journal_entries where id = $1',
      'update core.journal_entry_keys set entry_ref = entry_ref where entry_id = $1',
      'delete from core.journal_entry_keys where entry_id = $1',
    ]) {
      const error = await failure(async (c) => {
        await c.query(sql, [entryId]);
      });
      expect(error.code, sql).toBe('42501');
    }
    for (const sql of TRUNCATES) {
      const error = await failure(async (c) => {
        await c.query(sql);
      });
      expect(error.code, sql).toBe('42501');
    }
  });

  it('refuses them on partitions addressed directly', async () => {
    const partitions = await rw.query<{ name: string; writable: boolean }>(
      `select c.relname as name,
              has_table_privilege('mulapay_core_rw', c.oid, 'UPDATE, DELETE, TRUNCATE') as writable
         from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent in ('core.journal_entries'::regclass, 'core.journal_lines'::regclass)`
    );
    // Four months and a default partition per table.
    expect(partitions.rows.length).toBeGreaterThanOrEqual(10);
    expect(partitions.rows.filter((p) => p.writable)).toEqual([]);
    for (const sql of [
      'delete from core.journal_entries_default',
      'delete from core.journal_lines_default',
    ]) {
      const error = await failure(async (c) => {
        await c.query(sql);
      });
      expect(error.code, sql).toBe('42501');
    }
  });

  it('refuses them even for the superuser, through the append-only triggers', async () => {
    for (const sql of [
      `update core.journal_entries set description = 'changed' where id = $1`,
      'update core.journal_lines set amount_minor = 8 where entry_id = $1',
      'delete from core.journal_lines where entry_id = $1',
      'delete from core.journal_entries where id = $1',
      'delete from core.journal_entry_keys where entry_id = $1',
    ]) {
      const error = await failure(async (c) => {
        await c.query(sql, [entryId]);
      }, su);
      expect(error.message, sql).toMatch(/is append-only/);
    }
    for (const sql of TRUNCATES) {
      // TRUNCATE ... CASCADE takes exclusive locks on every journal table before its trigger
      // fires, so it can lose a deadlock to postings made by suites running beside this one
      // (the payment suites post to the ledger). A deadlock says nothing about the trigger:
      // try again. The assertion itself is unchanged.
      let error = await failure(async (c) => {
        await c.query(sql);
      }, su);
      for (let attempt = 0; attempt < 5 && error.code === '40P01'; attempt++) {
        error = await failure(async (c) => {
          await c.query(sql);
        }, su);
      }
      expect(error.message, sql).toMatch(/is append-only/);
    }
  });
});

describe('corrections use reversing entries', () => {
  async function linesOf(id: string) {
    const result = await rw.query<{ account_id: string; direction: string; amount_minor: string }>(
      'select account_id, direction, amount_minor from core.journal_lines where entry_id = $1 order by line_no',
      [id]
    );
    return result.rows;
  }

  it('accepts an exact mirror, and only one reversal per entry', async () => {
    const original = await balancedEntry(50);
    await commit(async (c) => {
      const id = await insertEntry(c, { reverses: original });
      await insertLine(c, id, 1, ids.bankB as string, 'debit', 50);
      await insertLine(c, id, 2, ids.bankA as string, 'credit', 50);
    });
    const second = await failure(async (c) => {
      const id = await insertEntry(c, { reverses: original });
      await insertLine(c, id, 1, ids.bankB as string, 'debit', 50);
      await insertLine(c, id, 2, ids.bankA as string, 'credit', 50);
    });
    expect(second.code).toBe('23505');
    expect(await linesOf(original)).toHaveLength(2);
  });

  it('refuses a reversal that does not mirror the original exactly', async () => {
    const original = await balancedEntry(60);
    const variants: [string, string, number][][] = [
      // same direction as the original
      [
        [ids.bankA as string, 'debit', 60],
        [ids.bankB as string, 'credit', 60],
      ],
      // partial amount
      [
        [ids.bankB as string, 'debit', 59],
        [ids.bankA as string, 'credit', 59],
      ],
      // extra balanced pair
      [
        [ids.bankB as string, 'debit', 60],
        [ids.bankA as string, 'credit', 60],
        [ids.bankB as string, 'debit', 1],
        [ids.bankA as string, 'credit', 1],
      ],
    ];
    for (const lines of variants) {
      const error = await failure(async (c) => {
        const id = await insertEntry(c, { reverses: original });
        for (const [i, [account, direction, amount]] of lines.entries()) {
          await insertLine(c, id, i + 1, account, direction, amount);
        }
      });
      expect(error.message).toMatch(/does not exactly reverse entry/);
    }
  });

  it('refuses reversing a reversal, a missing entry, or across currency or merchant', async () => {
    const original = await balancedEntry(70);
    let reversal = '';
    await commit(async (c) => {
      reversal = await insertEntry(c, { reverses: original });
      await insertLine(c, reversal, 1, ids.bankB as string, 'debit', 70);
      await insertLine(c, reversal, 2, ids.bankA as string, 'credit', 70);
    });
    const ofReversal = await failure(async (c) => {
      await insertEntry(c, { reverses: reversal });
    });
    expect(ofReversal.message).toMatch(/is a reversal and cannot be reversed/);
    const missing = await failure(async (c) => {
      await insertEntry(c, { reverses: randomUUID() });
    });
    expect(missing.code).toBe('23503');
    const another = await balancedEntry(80);
    for (const options of [
      { currency: 'KES' },
      { merchantId: merchant.id },
      { environment: 'live' },
    ]) {
      const error = await failure(async (c) => {
        await insertEntry(c, { reverses: another, ...options });
      });
      expect(error.message, JSON.stringify(options)).toMatch(/a reversal must keep/);
    }
  });
});

describe('balances cannot become inconsistent with the ledger', () => {
  it('refuses direct updates, deletes, truncates and non-zero inserts', async () => {
    await balancedEntry(5);
    for (const sql of [
      `update core.account_balances set posted_debits_minor = posted_debits_minor + 1 where account_id = $1`,
      `update core.account_balances set version = version where account_id = $1`,
      `insert into core.account_balances (account_id, currency, posted_debits_minor) values ($1, 'KES', 10)`,
      `insert into core.account_balances (account_id, currency, version) values ($1, 'KES', 3)`,
    ]) {
      const error = await failure(async (c) => {
        await c.query(sql, [ids.bankA]);
      });
      expect(error.code, sql).toBe('42501');
      expect(error.message).toMatch(/changes only through journal lines/);
    }
    for (const [sql, client] of [
      ['delete from core.account_balances where account_id = $1', rw],
      ['delete from core.account_balances where account_id = $1', su],
    ] as const) {
      const error = await failure(async (c) => {
        await c.query(sql, [ids.bankA]);
      }, client);
      expect(error.code).toBe('42501');
    }
    const truncate = await failure(async (c) => {
      await c.query('truncate core.account_balances');
    }, su);
    expect(truncate.message).toMatch(/append-only|not allowed/);
  });

  it('allows the all-zero insert the posting service uses for locking, in held currencies only', async () => {
    await commit(async (c) => {
      await c.query(
        `insert into core.account_balances (account_id, currency) values ($1, 'ZAR') on conflict do nothing`,
        [ids.payable]
      );
    });
    const error = await failure(async (c) => {
      await c.query(`insert into core.account_balances (account_id, currency) values ($1, 'UGX')`, [
        ids.bankKes,
      ]);
    });
    expect(error.message).toMatch(/does not hold UGX/);
  });
});

describe('the chart of accounts is enforced', () => {
  const insertAccount = (values: Record<string, string | boolean | null | undefined>) =>
    failure(async (c) => {
      const row = {
        id: randomUUID(),
        ref: publicId('account'),
        environment: 'test',
        code: '1100:bank:schema_test',
        name: 'n',
        type: 'asset',
        normal_balance: 'debit',
        merchant_id: null,
        provider: null,
        purpose: 'bank',
        is_system: true,
        ...values,
      };
      await c.query(
        `insert into core.accounts (id, ref, environment, code, name, type, normal_balance, merchant_id, provider, purpose, is_system)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        Object.values(row)
      );
      throw new Error('inserted');
    });

  it('refuses accounts whose code, type, normal balance or scope disagree with the chart', async () => {
    for (const values of [
      { normal_balance: 'credit' },
      { type: 'liability', normal_balance: 'credit' },
      { code: '1101:bank:schema_test' },
      { code: '1100:bank' },
      { purpose: 'suspense', code: '9000:suspense:x' },
      { code: '1000:provider_clearing:mtn', purpose: 'provider_clearing' },
      { code: '1000:provider_clearing:mtn', purpose: 'provider_clearing', provider: 'airtel' },
      { environment: 'staging' },
      { is_system: false },
      {
        code: `2000:merchant_payable:${merchant.ref}`,
        purpose: 'merchant_payable',
        type: 'liability',
        normal_balance: 'credit',
        is_system: false,
      },
    ]) {
      const error = await insertAccount(values);
      expect(error.code, JSON.stringify(values)).toBe('23514');
    }
  });

  it("refuses a merchant account qualified by another merchant's ref", async () => {
    const error = await insertAccount({
      code: `2000:merchant_payable:${otherMerchant.ref}`,
      purpose: 'merchant_payable',
      type: 'liability',
      normal_balance: 'credit',
      merchant_id: merchant.id,
      is_system: false,
    });
    expect(error.message).toMatch(/must be qualified by its merchant ref/);
  });

  it('allows renaming and deactivating, and nothing else; never deleting', async () => {
    await commit(async (c) => {
      await c.query(`update core.accounts set name = 'Renamed', active = true where id = $1`, [
        ids.bankB,
      ]);
    });
    for (const sql of [
      `update core.accounts set code = '1100:bank:renamed' where id = $1`,
      `update core.accounts set type = 'expense', normal_balance = 'debit' where id = $1`,
      `update core.accounts set environment = 'live' where id = $1`,
      `update core.accounts set currency = 'KES' where id = $1`,
    ]) {
      const error = await failure(async (c) => {
        await c.query(sql, [ids.bankB]);
      });
      expect(error.message, sql).toMatch(/only name and active can change/);
    }
    for (const client of [rw, su]) {
      const error = await failure(async (c) => {
        await c.query('delete from core.accounts where id = $1', [ids.bankB]);
      }, client);
      expect(error.code).toBe('42501');
    }
  });

  it('keeps currencies append-only', async () => {
    for (const client of [rw, su]) {
      for (const sql of [
        `update core.currencies set exponent = 2 where code = 'UGX'`,
        `delete from core.currencies where code = 'XAF'`,
      ]) {
        const error = await failure(async (c) => {
          await c.query(sql);
        }, client);
        expect(error.code, sql).toBe('42501');
      }
    }
  });
});
