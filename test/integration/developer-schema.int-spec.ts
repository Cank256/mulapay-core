/**
 * What Postgres enforces for the developer platform tables (migration 0005; spec 5.1, 5.2,
 * 11): partitions, append-only rules, the webhook delivery guard, and the checks that tie
 * the data together. Violations are made with plain SQL, as the application role where the
 * rule is a privilege and as the superuser where a trigger or check backs it.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMerchant,
  emitEvent,
  issueKey,
  pumpOutbox,
  startDeveloperContext,
  startReceiver,
  type DeveloperContext,
  type DeveloperMerchant,
} from '../support/developer';
import { connect } from '../support/ledger';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;
let other: DeveloperMerchant;
let rw: Client;
let endpointId: string;
let eventId: string;

beforeAll(async () => {
  ctx = await startDeveloperContext();
  rw = await connect('rw');
  merchant = await createMerchant(ctx, { active: true, label: 'schema' });
  other = await createMerchant(ctx, { active: true, label: 'schema-other' });
  const key = await issueKey(ctx, merchant.owner, {
    environment: 'test',
    scopes: ['webhooks:write'],
  });
  const receiver = await startReceiver();
  try {
    const res = await key.client.post('/v1/webhook-endpoints', {
      url: receiver.url,
      enabledEvents: ['*'],
    });
    endpointId = String(
      (
        await ctx.sql('select id from core.webhook_endpoints where ref = $1', [res.json().data.id])
      )[0]?.id
    );
  } finally {
    await receiver.close();
  }
  eventId = (await emitEvent(ctx, merchant)).id;
  await pumpOutbox(ctx, merchant.id);
});
afterAll(async () => {
  await rw.end();
  await ctx.close();
});

const NOW = () => new Date().toISOString();
function deliveryInsert(overrides: Record<string, unknown> = {}) {
  const ref = `whd_${'0'.repeat(10)}${randomUUID()
    .replace(/-/g, '')
    .slice(0, 16)
    .toUpperCase()
    .replace(/[ILOU]/g, '1')}`;
  const row = {
    id: randomUUID(),
    ref,
    endpoint_id: endpointId,
    merchant_id: merchant.id,
    environment: 'test',
    event_id: eventId,
    event_type: 'payment.created',
    dedupe_key: `schema:${ref}`,
    status: 'pending',
    attempt: 0,
    next_attempt_at: NOW(),
    created_at: NOW(),
    ...overrides,
  };
  const columns = Object.keys(row);
  return {
    text: `insert into core.webhook_deliveries (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    values: Object.values(row),
  };
}
const insertDelivery = (overrides?: Record<string, unknown>) => {
  const { text, values } = deliveryInsert(overrides);
  return ctx.sql(text, values);
};

/** Partition names come from pg_class, never from input; the regex makes that explicit. */
function deleteFromPartition(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected partition name ${name}`);
  return `delete from core.${name}`;
}

describe('partitions', () => {
  it('webhook deliveries and request logs are partitioned by month, with a default partition', async () => {
    for (const table of ['webhook_deliveries', 'api_request_logs']) {
      const rows = await ctx.sql(
        `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = ('core.' || $1)::regclass order by c.relname`,
        [table]
      );
      const names = rows.map((r) => String(r.relname));
      expect(names, table).toContain(`${table}_default`);
      expect(names.filter((n) => /_\d{6}$/.test(n)).length, table).toBeGreaterThanOrEqual(4);
      const parent = await ctx.sql(
        "select relkind from pg_class where oid = ('core.' || $1)::regclass",
        [table]
      );
      expect(parent[0]?.relkind).toBe('p');
    }
  });

  it('a row outside the created months lands in the default partition instead of failing', async () => {
    await insertDelivery({ created_at: '2019-03-01T00:00:00.000Z' });
    const rows = await ctx.sql(
      "select tableoid::regclass::text as part from core.webhook_deliveries where created_at = '2019-03-01T00:00:00Z' and merchant_id = $1",
      [merchant.id]
    );
    expect(rows[0]?.part).toBe('core.webhook_deliveries_default');
  });
});

describe('privileges of the application role', () => {
  it.each([
    'delete from core.webhook_deliveries',
    'truncate core.webhook_deliveries',
    'update core.api_request_logs set status_code = 200',
    'delete from core.api_request_logs',
    'truncate core.api_request_logs',
    'update core.merchant_events set type = type',
    'delete from core.merchant_events',
    'truncate core.merchant_events',
    'delete from core.webhook_endpoints',
    'truncate core.outbox',
  ])('refuses %s', async (statement) => {
    await expect(rw.query(statement)).rejects.toThrow(/permission denied|append-only/);
  });

  it('refuses the same on a partition addressed directly', async () => {
    const part = String(
      (
        await ctx.sql(
          "select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'core.api_request_logs'::regclass and c.relname <> 'api_request_logs_default' limit 1"
        )
      )[0]?.relname
    );
    await expect(rw.query(deleteFromPartition(part))).rejects.toThrow(/permission denied/);
    const wd = String(
      (
        await ctx.sql(
          "select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'core.webhook_deliveries'::regclass and c.relname <> 'webhook_deliveries_default' limit 1"
        )
      )[0]?.relname
    );
    await expect(rw.query(deleteFromPartition(wd))).rejects.toThrow(/permission denied/);
  });

  it('allows what the application needs: deliveries are updated while pending, outbox rows deleted when published', async () => {
    const { text, values } = deliveryInsert();
    await rw.query(text, values);
    await rw.query('update core.webhook_deliveries set locked_until = now() where ref = $1', [
      values[1],
    ]);
    const row = {
      id: randomUUID(),
      type: 'test.deletable',
    };
    await rw.query(
      "insert into core.outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, locked_at, published_at) values ($1, 't', 'x', $2, '{}', $3, now(), now())",
      [row.id, row.type, `del:${row.id}`]
    );
    await expect(
      rw.query('delete from core.outbox where id = $1', [row.id])
    ).resolves.toBeDefined();
  });
});

describe('the delivery guard', () => {
  it('starts a delivery pending with no attempts', async () => {
    await expect(insertDelivery({ status: 'succeeded', next_attempt_at: null })).rejects.toThrow(
      /starts pending/
    );
    await expect(insertDelivery({ attempt: 1 })).rejects.toThrow(/starts pending/);
  });

  it('refuses a delivery whose endpoint, event, merchant or environment do not agree', async () => {
    await expect(insertDelivery({ merchant_id: other.id })).rejects.toThrow(
      /endpoint does not belong/
    );
    await expect(insertDelivery({ environment: 'live' })).rejects.toThrow(
      /endpoint does not belong/
    );
    await expect(insertDelivery({ event_type: 'payment.failed' })).rejects.toThrow(
      /does not match the merchant, environment and type/
    );
    const foreignEvent = (await emitEvent(ctx, other)).id;
    await expect(insertDelivery({ event_id: foreignEvent })).rejects.toThrow(/does not match/);
  });

  it('keeps a pending delivery consistent: pending exactly when a next attempt is set', async () => {
    await expect(insertDelivery({ next_attempt_at: null })).rejects.toThrow(
      /webhook_deliveries_pending_check/
    );
    await expect(insertDelivery({ attempt: 8 })).rejects.toThrow(
      /webhook_deliveries_attempt_check|starts pending/
    );
    await expect(insertDelivery({ status: 'bogus' })).rejects.toThrow(
      /status_check|starts pending/
    );
  });

  it('refuses a second delivery for the same endpoint and event time (repeated fan-out)', async () => {
    const at = NOW();
    const key = `dup:${randomUUID()}`;
    await insertDelivery({ dedupe_key: key, created_at: at });
    await expect(insertDelivery({ dedupe_key: key, created_at: at })).rejects.toThrow(
      /unique|duplicate/
    );
  });

  it('lets a pending delivery move on once, and then it is final', async () => {
    const { text, values } = deliveryInsert();
    await ctx.sql(text, values);
    const ref = values[1];
    await ctx.sql(
      "update core.webhook_deliveries set attempt = 1, status = 'pending', next_attempt_at = now() where ref = $1",
      [ref]
    );
    await expect(
      ctx.sql('update core.webhook_deliveries set attempt = 0 where ref = $1', [ref])
    ).rejects.toThrow(/never decrease/);
    await ctx.sql(
      "update core.webhook_deliveries set status = 'exhausted', next_attempt_at = null, attempt = 2 where ref = $1",
      [ref]
    );
    await expect(
      ctx.sql("update core.webhook_deliveries set status = 'succeeded' where ref = $1", [ref])
    ).rejects.toThrow(/final/);
    await expect(
      ctx.sql('update core.webhook_deliveries set merchant_id = $2 where ref = $1', [ref, other.id])
    ).rejects.toThrow(/identity columns/);
  });
});

describe('webhook endpoints, events, the outbox and keys', () => {
  it('endpoint identity never changes', async () => {
    await expect(
      ctx.sql('update core.webhook_endpoints set merchant_id = $2 where id = $1', [
        endpointId,
        other.id,
      ])
    ).rejects.toThrow(/identity columns/);
    await expect(
      ctx.sql("update core.webhook_endpoints set environment = 'live' where id = $1", [endpointId])
    ).rejects.toThrow(/identity columns/);
  });

  it('an endpoint is disabled exactly when it has a disabled time, and holds both previous-secret columns or neither', async () => {
    await expect(
      ctx.sql("update core.webhook_endpoints set status = 'disabled' where id = $1", [endpointId])
    ).rejects.toThrow(/webhook_endpoints_disabled_check/);
    await expect(
      ctx.sql("update core.webhook_endpoints set previous_secret_enc = 'x' where id = $1", [
        endpointId,
      ])
    ).rejects.toThrow(/webhook_endpoints_previous_secret_check/);
    await expect(
      ctx.sql("update core.webhook_endpoints set enabled_events = '{}' where id = $1", [endpointId])
    ).rejects.toThrow(/webhook_endpoints_events_check/);
    await expect(
      ctx.sql('update core.webhook_endpoints set failure_count = -1 where id = $1', [endpointId])
    ).rejects.toThrow(/failure_count_check/);
  });

  it('an event type has the shape of one', async () => {
    for (const bad of ['payment', 'Payment.Created', 'payment.created!', '']) {
      await expect(
        ctx.sql(
          "insert into core.merchant_events (id, ref, merchant_id, environment, type, resource_type, resource_id, payload) values ($1, $2, $3, 'test', $4, 'x', 'y', '{}')",
          [randomUUID(), `evt_${'0'.repeat(26)}`, merchant.id, bad]
        )
      ).rejects.toThrow(/merchant_events_type_check/);
    }
  });

  it('an outbox row is published only after it was claimed, and keeps one row per business fact', async () => {
    const id = randomUUID();
    await expect(
      ctx.sql(
        "insert into core.outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, published_at) values ($1, 't', 'x', 'test.row', '{}', $2, now())",
        [id, `k:${id}`]
      )
    ).rejects.toThrow(/outbox_published_check/);
    await ctx.sql(
      "insert into core.outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key) values ($1, 't', 'x', 'test.row', '{}', $2)",
      [id, `k:${id}`]
    );
    await expect(
      ctx.sql(
        "insert into core.outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key) values ($1, 't', 'x', 'test.row', '{}', $2)",
        [randomUUID(), `k:${id}`]
      )
    ).rejects.toThrow(/outbox_dedupe_key_key/);
    await expect(
      ctx.sql('update core.outbox set attempts = -1 where id = $1', [id])
    ).rejects.toThrow(/outbox_attempts_check/);
  });

  it('a key that requires signing has a signing secret, and a rate limit stays in range', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    await expect(
      ctx.sql(
        'update core.api_keys set signing_required = true, signing_secret_enc = null where ref = $1',
        [key.ref]
      )
    ).rejects.toThrow(/api_keys_signing_check/);
    await expect(
      ctx.sql('update core.api_keys set rate_limit_rpm = 0 where ref = $1', [key.ref])
    ).rejects.toThrow(/api_keys_rate_limit_check/);
    await expect(
      ctx.sql('update core.api_keys set rate_limit_rpm = 100001 where ref = $1', [key.ref])
    ).rejects.toThrow(/api_keys_rate_limit_check/);
  });

  it('a request log has a valid status and latency, and the key and merchant must exist', async () => {
    const base = ['gen', 'rl_x', merchant.id, 'test'];
    void base;
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const keyId = String(
      (await ctx.sql('select id from core.api_keys where ref = $1', [key.ref]))[0]?.id
    );
    const insert = (
      statusCode: number,
      latency: number,
      merchantId = merchant.id,
      apiKey = keyId
    ) =>
      ctx.sql(
        "insert into core.api_request_logs (id, ref, merchant_id, environment, api_key_id, method, path, route, status_code, latency_ms, request_id) values ($1, $2, $3, 'test', $4, 'GET', '/v1/ping', '/v1/ping', $5, $6, 'req-1')",
        [randomUUID(), `rl_${randomUUID()}`, merchantId, apiKey, statusCode, latency]
      );
    await expect(insert(200, 5)).resolves.toBeDefined();
    await expect(insert(99, 5)).rejects.toThrow(/api_request_logs_status_check/);
    await expect(insert(600, 5)).rejects.toThrow(/api_request_logs_status_check/);
    await expect(insert(200, -1)).rejects.toThrow(/api_request_logs_latency_check/);
    await expect(insert(200, 5, randomUUID())).rejects.toThrow(/foreign key/);
    await expect(insert(200, 5, merchant.id, randomUUID())).rejects.toThrow(/foreign key/);
  });
});
