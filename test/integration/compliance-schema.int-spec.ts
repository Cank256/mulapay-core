/**
 * The database enforces the compliance rules on its own (migration 0007): state machines,
 * immutable evidence, append-only history and the grants. Each test tries to break one rule
 * as the application's own database role, bypassing the services, and expects Postgres to
 * refuse.
 */
import { randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { registerMerchantUser } from '../support/identity';
import { sql } from '../support/payments';
import { startComplianceContext, type ComplianceContext } from '../support/compliance';
import { merchantWithPayment } from '../support/disputes';

let ctx: ComplianceContext;
let rw: PgClient;
let merchantId: string;
let staffId: string;
beforeAll(async () => {
  ctx = await startComplianceContext();
  rw = new PgClient({ connectionString: inject('databaseUrls').rw });
  await rw.connect();
  const owner = await registerMerchantUser(ctx, 'schema');
  merchantId = (
    await sql<{ id: string }>('select id from core.merchants where ref = $1', [owner.merchantId])
  )[0]?.id as string;
  staffId = (await sql<{ id: string }>('select id from core.users limit 1'))[0]?.id as string;
});
afterAll(async () => {
  await rw?.end();
  await ctx?.close();
});

/** The Postgres error code of a statement, or `ok`. Each runs in a savepoint so one failure does not poison the rest. */
async function codeOf(text: string, values: unknown[] = []): Promise<string> {
  try {
    await rw.query('begin');
    await rw.query(text, values);
    await rw.query('rollback');
    return 'ok';
  } catch (error) {
    await rw.query('rollback').catch(() => undefined);
    return (error as { code?: string }).code ?? 'unknown';
  }
}

const CHECK = '23514';
const DENIED = '42501';
const UNIQUE = '23505';

async function profileId(): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into core.kyc_profiles (id, merchant_id, level, status) values ($1, $2, 0, 'not_started')
     on conflict (merchant_id) do nothing`,
    [id, merchantId]
  );
  return (
    await sql<{ id: string }>('select id from core.kyc_profiles where merchant_id = $1', [
      merchantId,
    ])
  )[0]?.id as string;
}

describe('KYC', () => {
  it('moves a profile only along the allowed transitions', async () => {
    const id = await profileId();
    expect(
      await codeOf(`update core.kyc_profiles set status = 'approved' where id = $1`, [id])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.kyc_profiles set status = 'in_review' where id = $1`, [id])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.kyc_profiles set status = 'pending' where id = $1`, [id])
    ).toBe('ok');
    expect(
      await codeOf(`update core.kyc_profiles set status = 'nonsense' where id = $1`, [id])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.kyc_profiles set merchant_id = $2 where id = $1`, [
        id,
        randomUUID(),
      ])
    ).not.toBe('ok');
    expect(await codeOf(`update core.kyc_profiles set level = 4 where id = $1`, [id])).toBe(CHECK);
    expect(
      await codeOf(`update core.kyc_profiles set submission_no = -1 where id = $1`, [id])
    ).toBe(CHECK);
    // Approved needs an expiry and a reviewer; rejected needs reasons.
    await sql(`update core.kyc_profiles set status = 'pending' where id = $1`, [id]);
    expect(
      await codeOf(`update core.kyc_profiles set status = 'approved' where id = $1`, [id])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.kyc_profiles set status = 'rejected' where id = $1`, [id])
    ).toBe(CHECK);
    expect(await codeOf(`delete from core.kyc_profiles where id = $1`, [id])).toBe(DENIED);
  });

  it('never changes a document’s file, and refuses types and sizes that are not allowed', async () => {
    const id = await profileId();
    const docId = randomUUID();
    const insert = (over: Record<string, unknown> = {}) => {
      const v = {
        mime: 'application/pdf',
        size: 1000,
        hash: 'a'.repeat(64),
        type: 'national_id',
        ...over,
      };
      const row: [string, unknown[]] = [
        `insert into core.kyc_documents (id, ref, merchant_id, kyc_profile_id, type, file_key, file_hash, mime,
           size_bytes, status, uploaded_by, uploaded_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'uploaded', $10, now())`,
        [
          randomUUID(),
          `kdoc_${'0'.repeat(25)}${Math.floor(Math.random() * 10)}`,
          merchantId,
          id,
          v.type,
          `k/${randomUUID()}`,
          v.hash,
          v.mime,
          v.size,
          staffId,
        ],
      ];
      return row;
    };
    expect(await codeOf(...insert({ mime: 'application/zip' }))).toBe(CHECK);
    expect(await codeOf(...insert({ mime: 'image/gif' }))).toBe(CHECK);
    expect(await codeOf(...insert({ size: 10 * 1024 * 1024 + 1 }))).toBe(CHECK);
    expect(await codeOf(...insert({ size: 0 }))).toBe(CHECK);
    expect(await codeOf(...insert({ hash: 'not-a-hash' }))).toBe(CHECK);
    expect(await codeOf(...insert({ type: 'Bad Type' }))).toBe(CHECK);

    const ref = `kdoc_0000000000000000000000${Math.floor(1000 + Math.random() * 8999)}`.slice(
      0,
      31
    );
    await sql(
      `insert into core.kyc_documents (id, ref, merchant_id, kyc_profile_id, type, file_key, file_hash, mime, size_bytes,
         status, uploaded_by, uploaded_at) values ($1, $2, $3, $4, 'national_id', $5, $6, 'image/png', 500, 'uploaded', $7, now())`,
      [docId, ref, merchantId, id, `k/${docId}`, 'b'.repeat(64), staffId]
    );
    for (const column of ['file_key', 'file_hash', 'mime', 'size_bytes', 'type', 'merchant_id']) {
      const value =
        column === 'size_bytes'
          ? '600'
          : column === 'mime'
            ? 'image/jpeg'
            : column === 'merchant_id'
              ? randomUUID()
              : 'x'.repeat(10);
      expect(
        await codeOf(`update core.kyc_documents set ${column} = $2 where id = $1`, [
          docId,
          column === 'file_hash' ? 'c'.repeat(64) : value,
        ]),
        column
      ).not.toBe('ok');
    }
    expect(await codeOf(`delete from core.kyc_documents where id = $1`, [docId])).toBe(DENIED);
    // A verified document is final.
    await sql(
      `update core.kyc_documents set status = 'verified', verified_by = $2, verified_at = now() where id = $1`,
      [docId, staffId]
    );
    expect(
      await codeOf(
        `update core.kyc_documents set status = 'rejected', rejection_reason = 'expired' where id = $1`,
        [docId]
      )
    ).toBe(CHECK);
    expect(
      await codeOf(
        `update core.kyc_documents set verified_by = null, verified_at = null where id = $1`,
        [docId]
      )
    ).toBe(CHECK);
  });

  it('keeps reviews and verifications append-only', async () => {
    const id = await profileId();
    await sql(
      `insert into core.kyc_reviews (id, kyc_profile_id, merchant_id, submission_no, decision, level) values ($1, $2, $3, 1, 'submitted', 1)`,
      [randomUUID(), id, merchantId]
    );
    await sql(
      `insert into core.kyc_verifications (id, kyc_profile_id, merchant_id, check_type, provider, status, submission_no, performed_at) values ($1, $2, $3, 'contact', 'manual', 'passed', 1, now())`,
      [randomUUID(), id, merchantId]
    );
    for (const table of ['kyc_reviews', 'kyc_verifications']) {
      expect(await codeOf(`update core.${table} set created_at = now()`), table).toBe(DENIED);
      expect(await codeOf(`delete from core.${table}`), table).toBe(DENIED);
      expect(await codeOf(`truncate core.${table}`), table).toBe(DENIED);
    }
    expect(
      await codeOf(
        `insert into core.kyc_verifications (id, kyc_profile_id, merchant_id, check_type, provider, status, submission_no, performed_at) values ($1, $2, $3, 'sanctions_x', 'manual', 'passed', 1, now())`,
        [randomUUID(), id, merchantId]
      )
    ).toBe(CHECK);
  });

  it('refuses limits that do not make sense', async () => {
    const insert = (perTxn: number, daily: number, monthly: number) =>
      codeOf(
        `insert into core.merchant_limits (merchant_id, currency, per_txn_max_minor, daily_volume_max_minor, monthly_volume_max_minor,
           payout_per_txn_max_minor, daily_payout_max_minor) values ($1, 'KRW', $2, $3, $4, $2, $3)`,
        [merchantId, perTxn, daily, monthly]
      );
    expect(await insert(0, 10, 10)).toBe(CHECK);
    expect(await insert(100, 50, 200)).toBe(CHECK); // daily below per-transaction
    expect(await insert(100, 300, 200)).toBe(CHECK); // monthly below daily
    expect(await insert(100, 200, 300)).toBe('ok');
    expect(
      await codeOf(`delete from core.merchant_limits where merchant_id = $1`, [merchantId])
    ).toBe(DENIED);
  });
});

describe('AML', () => {
  async function screening(status: string) {
    const id = randomUUID();
    await sql(
      `insert into core.aml_screenings (id, ref, merchant_id, subject_type, subject_id, dedupe_key, provider, status, screened_at)
       values ($1, $2, $3, 'merchant', 'mch_x', $4, 'test', $5, now())`,
      [
        id,
        `scr_0000000000000000000000${Math.floor(1000 + Math.random() * 8999)}`.slice(0, 30),
        merchantId,
        `k:${id}`,
        status,
      ]
    );
    return id;
  }

  it('decides a potential match once, and never changes what was screened', async () => {
    const potential = await screening('potential_match');
    expect(
      await codeOf(`update core.aml_screenings set status = 'potential_match' where id = $1`, [
        potential,
      ])
    ).toBe('ok');
    expect(
      await codeOf(`update core.aml_screenings set hit_count = 9 where id = $1`, [potential])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.aml_screenings set subject_id = 'other' where id = $1`, [potential])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.aml_screenings set result = '{"hits":[]}' where id = $1`, [
        potential,
      ])
    ).toBe(CHECK);
    expect(
      await codeOf(
        `update core.aml_screenings set status = 'confirmed_match', reviewed_by = $2, reviewed_at = now() where id = $1`,
        [potential, staffId]
      )
    ).toBe('ok');
    const confirmed = await screening('confirmed_match');
    expect(
      await codeOf(
        `update core.aml_screenings set status = 'clear', reviewed_by = $2, reviewed_at = now() where id = $1`,
        [confirmed, staffId]
      )
    ).toBe(CHECK);
    const clear = await screening('clear');
    expect(
      await codeOf(`update core.aml_screenings set status = 'confirmed_match' where id = $1`, [
        clear,
      ])
    ).toBe(CHECK);
    expect(await codeOf(`delete from core.aml_screenings where id = $1`, [clear])).toBe(DENIED);
  });

  it('keeps alerts unique per rule and transaction, and closed alerts final', async () => {
    const tx = randomUUID();
    const insert = (ref: string, rule: string, status = 'open', transaction: string | null = tx) =>
      codeOf(
        `insert into core.aml_alerts (id, ref, rule_code, rule_version, severity, merchant_id, transaction_id, status, action, due_at)
         values ($1, $2, $3, 1, 'low', $4, $5, $6, 'flag', now() + interval '1 day')`,
        [randomUUID(), ref, rule, merchantId, transaction, status]
      );
    expect(await insert('alrt_00000000000000000000000001', 'rule.a', 'closed_confirmed')).toBe(
      CHECK
    ); // closed needs a resolver
    await sql(
      `insert into core.aml_alerts (id, ref, rule_code, rule_version, severity, merchant_id, transaction_id, action, due_at)
       values ($1, 'alrt_00000000000000000000000002', 'rule.unique', 1, 'low', $2, $3, 'flag', now() + interval '1 day')`,
      [randomUUID(), merchantId, tx]
    );
    expect(await insert('alrt_00000000000000000000000003', 'rule.unique')).toBe(UNIQUE);
    expect(await insert('alrt_00000000000000000000000004', 'rule.other')).toBe('ok');
    expect(await insert('bad_ref', 'rule.x')).toBe(CHECK);
    const open = 'alrt_00000000000000000000000002';
    expect(
      await codeOf(`update core.aml_alerts set severity = 'critical' where ref = $1`, [open])
    ).toBe(CHECK);
    expect(await codeOf(`update core.aml_alerts set due_at = now() where ref = $1`, [open])).toBe(
      CHECK
    );
    expect(
      await codeOf(`update core.aml_alerts set status = 'investigating' where ref = $1`, [open])
    ).toBe('ok');
    await sql(`update core.aml_alerts set status = 'investigating' where ref = $1`, [open]);
    expect(await codeOf(`update core.aml_alerts set status = 'open' where ref = $1`, [open])).toBe(
      CHECK
    );
    await sql(
      `update core.aml_alerts set status = 'closed_false_positive', resolved_by = $2, resolved_at = now() where ref = $1`,
      [open, staffId]
    );
    expect(
      await codeOf(
        `update core.aml_alerts set status = 'escalated', escalated_at = now(), escalation_reason = 'manual' where ref = $1`,
        [open]
      )
    ).toBe(CHECK);
    expect(await codeOf(`delete from core.aml_alerts where ref = $1`, [open])).toBe(DENIED);
  });

  it('closes a case only with an outcome, and then keeps it closed', async () => {
    const id = randomUUID();
    await sql(
      `insert into core.aml_cases (id, ref, merchant_id, severity, title, source) values ($1, $2, $3, 'low', 'T', 'manual')`,
      [
        id,
        `case_0000000000000000000000${Math.floor(1000 + Math.random() * 8999)}`.slice(0, 31),
        merchantId,
      ]
    );
    expect(await codeOf(`update core.aml_cases set status = 'closed' where id = $1`, [id])).toBe(
      CHECK
    );
    expect(
      await codeOf(`update core.aml_cases set outcome = 'no_action' where id = $1`, [id])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.aml_cases set merchant_id = $2 where id = $1`, [id, randomUUID()])
    ).not.toBe('ok');
    await sql(
      `update core.aml_cases set status = 'closed', outcome = 'no_action', closed_by = $2, closed_at = now() where id = $1`,
      [id, staffId]
    );
    expect(await codeOf(`update core.aml_cases set title = 'new' where id = $1`, [id])).toBe(CHECK);
    expect(
      await codeOf(`update core.aml_cases set outcome = 'false_positive' where id = $1`, [id])
    ).toBe(CHECK);
    // The filing is recorded once, even after the case closed.
    expect(
      await codeOf(
        `update core.aml_cases set str_filed_at = now(), str_reference = 'R1' where id = $1`,
        [id]
      )
    ).toBe('ok');
    await sql(
      `update core.aml_cases set str_filed_at = now(), str_reference = 'R1' where id = $1`,
      [id]
    );
    expect(await codeOf(`update core.aml_cases set str_reference = 'R2' where id = $1`, [id])).toBe(
      CHECK
    );
    expect(await codeOf(`delete from core.aml_cases where id = $1`, [id])).toBe(DENIED);
  });

  it('allows one active block per merchant, and ends a block only by lifting it', async () => {
    const insert = (ref: string) =>
      codeOf(
        `insert into core.aml_blocks (id, ref, merchant_id, reason, source, created_by) values ($1, $2, $3, 'r', 'manual', 'system:aml')`,
        [randomUUID(), ref, merchantId]
      );
    await sql(
      `insert into core.aml_blocks (id, ref, merchant_id, reason, source, created_by) values ($1, 'blk_00000000000000000000000001', $2, 'r', 'manual', 'system:aml')`,
      [randomUUID(), merchantId]
    );
    expect(await insert('blk_00000000000000000000000002')).toBe(UNIQUE);
    expect(
      await codeOf(
        `update core.aml_blocks set reason = 'other' where ref = 'blk_00000000000000000000000001'`
      )
    ).toBe(CHECK);
    expect(
      await codeOf(
        `update core.aml_blocks set status = 'lifted' where ref = 'blk_00000000000000000000000001'`
      )
    ).toBe(CHECK);
    await sql(
      `update core.aml_blocks set status = 'lifted', lifted_at = now(), lifted_by = $1 where ref = 'blk_00000000000000000000000001'`,
      [staffId]
    );
    expect(await insert('blk_00000000000000000000000003')).toBe('ok'); // a new block may follow a lifted one
    expect(
      await codeOf(
        `update core.aml_blocks set status = 'active', lifted_at = null, lifted_by = null where ref = 'blk_00000000000000000000000001'`
      )
    ).toBe(CHECK);
    expect(await codeOf(`delete from core.aml_blocks`)).toBe(DENIED);
  });

  it('never deletes a blocklist entry or changes what it holds', async () => {
    const id = randomUUID();
    await sql(
      `insert into core.aml_blocklist (id, ref, entry_type, value_hmac, value_hint, reason) values ($1, $2, 'msisdn', $3, '1234', 'r')`,
      [
        id,
        `bl_000000000000000000000000${Math.floor(10 + Math.random() * 89)}`.slice(0, 29),
        'd'.repeat(64),
      ]
    );
    expect(await codeOf(`delete from core.aml_blocklist where id = $1`, [id])).toBe(DENIED);
    expect(
      await codeOf(`update core.aml_blocklist set value_hmac = $2 where id = $1`, [
        id,
        'e'.repeat(64),
      ])
    ).toBe(CHECK);
    expect(
      await codeOf(`update core.aml_blocklist set reason = 'changed' where id = $1`, [id])
    ).toBe(CHECK);
    expect(
      await codeOf(
        `insert into core.aml_blocklist (id, ref, entry_type, value_hmac, value_hint, reason) values ($1, 'bl_00000000000000000000000099', 'msisdn', $2, '1234', 'dup')`,
        [randomUUID(), 'd'.repeat(64)]
      )
    ).toBe(UNIQUE);
    expect(
      await codeOf(
        `update core.aml_blocklist set removed_at = now(), removed_by = $2 where id = $1`,
        [id, staffId]
      )
    ).toBe('ok');
  });

  it('keeps rule history, notes, packages, facts and block holds append-only', async () => {
    for (const table of [
      'aml_rule_versions',
      'aml_case_notes',
      'aml_str_packages',
      'aml_transaction_facts',
      'aml_block_holds',
    ]) {
      expect(await codeOf(`delete from core.${table}`), table).toBe(DENIED);
      expect(await codeOf(`truncate core.${table}`), table).toBe(DENIED);
    }
    expect(await codeOf(`update core.aml_rule_versions set reason = 'x'`)).toBe(DENIED);
    expect(await codeOf(`update core.aml_transaction_facts set status = 'failed'`)).toBe(DENIED);
    expect(await codeOf(`delete from core.aml_rules`)).toBe(DENIED);
    expect(
      await codeOf(`update core.aml_rules set rule_type = 'velocity' where rule_type = 'geography'`)
    ).toBe('ok');
    expect(
      await codeOf(
        `update core.aml_rules set severity = 'extreme' where code = 'velocity.count.hourly'`
      )
    ).toBe(CHECK);
    expect(
      await codeOf(
        `update core.aml_rules set action = 'reverse' where code = 'velocity.count.hourly'`
      )
    ).toBe(CHECK);
    expect(
      await codeOf(
        `update core.aml_rules set effective_to = effective_from - interval '1 day' where code = 'velocity.count.hourly'`
      )
    ).toBe(CHECK);
  });
});

describe('disputes', () => {
  it('holds the disputed amount consistently, allows one unresolved dispute per payment, and is final once resolved', async () => {
    const { merchant, payment } = await merchantWithPayment(ctx, 10_000n);
    const base = [merchant.id, payment.transactionId];
    const insert = (
      ref: string,
      over: { amount?: number; held?: number; short?: number; hold?: boolean } = {}
    ) =>
      codeOf(
        `insert into core.disputes (id, ref, transaction_id, merchant_id, kind, amount_minor, currency, reason_code,
           hold_minor, shortfall_minor, created_by) values ($1, $2, $3, $4, 'chargeback', $5, 'XOF', '4853', $6, $7, 'user:x')`,
        [
          randomUUID(),
          ref,
          base[1],
          base[0],
          over.amount ?? 1000,
          over.held ?? 1000,
          over.short ?? 0,
        ]
      );
    expect(await insert('dsp_00000000000000000000000001', { held: 400, short: 400 })).toBe(CHECK); // does not add up
    expect(await insert('dsp_00000000000000000000000001', { amount: 0, held: 0, short: 0 })).toBe(
      CHECK
    );
    expect(await insert('dsp_00000000000000000000000001', { held: 1000 })).toBe(CHECK); // hold amount without a hold
    expect(await insert('dsp_00000000000000000000000001', { held: 0, short: 1000 })).toBe('ok');
    const id = randomUUID();
    await sql(
      `insert into core.disputes (id, ref, transaction_id, merchant_id, kind, amount_minor, currency, reason_code, hold_minor, shortfall_minor, created_by)
       values ($1, $2, $3, $4, 'chargeback', 1000, 'XOF', '4853', 0, 1000, 'user:x')`,
      [
        id,
        `dsp_0000000000000000000000${Math.floor(1000 + Math.random() * 8999)}`.slice(0, 30),
        base[1],
        base[0],
      ]
    );
    expect(await insert('dsp_00000000000000000000000009', { held: 0, short: 1000 })).toBe(UNIQUE);
    for (const set of [
      'amount_minor = 999',
      "kind = 'inquiry'",
      "currency = 'USD'",
      'hold_minor = 5',
      `merchant_id = '${randomUUID()}'`,
    ]) {
      expect(await codeOf(`update core.disputes set ${set} where id = $1`, [id]), set).not.toBe(
        'ok'
      );
    }
    expect(await codeOf(`update core.disputes set status = 'resolved' where id = $1`, [id])).toBe(
      CHECK
    ); // needs an outcome
    expect(
      await codeOf(`update core.disputes set status = 'under_review' where id = $1`, [id])
    ).toBe('ok');
    await sql(`update core.disputes set status = 'under_review' where id = $1`, [id]);
    expect(await codeOf(`update core.disputes set status = 'open' where id = $1`, [id])).toBe(
      CHECK
    );
    await sql(
      `update core.disputes set status = 'resolved', outcome = 'withdrawn', resolved_at = now(), resolved_by = $2 where id = $1`,
      [id, staffId]
    );
    expect(
      await codeOf(`update core.disputes set outcome = 'merchant_lost' where id = $1`, [id])
    ).toBe(CHECK);
    expect(
      await codeOf(
        `update core.disputes set status = 'open', outcome = null, resolved_at = null where id = $1`,
        [id]
      )
    ).toBe(CHECK);
    expect(await codeOf(`delete from core.disputes where id = $1`, [id])).toBe(DENIED);
    // Once resolved, the payment may be disputed again.
    expect(await insert('dsp_00000000000000000000000008', { held: 0, short: 1000 })).toBe('ok');
  });
});

describe('requirements data', () => {
  it('cannot be deleted, and each row names a valid kind, country and business type', async () => {
    expect(await codeOf(`delete from core.kyc_requirements`)).toBe(DENIED);
    expect(await codeOf(`delete from core.kyc_level_limits`)).toBe(DENIED);
    const insert = (over: Record<string, string>) => {
      const v = {
        level: '1',
        country: '*',
        bt: '*',
        code: 'zz_test',
        kind: 'document',
        key: 'zz_test',
        ...over,
      };
      return codeOf(
        `insert into core.kyc_requirements (id, level, country, business_type, requirement_code, kind, evidence_key, label)
         values ($1, $2, $3, $4, $5, $6, $7, 'x')`,
        [randomUUID(), v.level, v.country, v.bt, v.code, v.kind, v.key]
      );
    };
    expect(await insert({ level: '0' })).toBe(CHECK);
    expect(await insert({ level: '4' })).toBe(CHECK);
    expect(await insert({ country: 'uganda' })).toBe(CHECK);
    expect(await insert({ bt: 'Limited Company' })).toBe(CHECK);
    expect(await insert({ kind: 'telepathy' })).toBe(CHECK);
    expect(await insert({ code: 'Bad Code' })).toBe(CHECK);
    expect(await insert({ code: 'identity_document', level: '1' })).toBe(UNIQUE); // already seeded
    expect(await insert({})).toBe('ok');
  });
});
