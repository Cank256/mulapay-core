/**
 * API key security (spec 6.11, 8.3, 11; Phase 5): format and secrecy, invalid and revoked
 * keys, the Redis cache and its invalidation, rotation, scopes on every route, IP allowlists
 * and trusted-proxy handling.
 */
import { createHash } from 'node:crypto';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyCache } from '../../src/common/auth/api-key-cache';
import { ApiKeyUsageTracker } from '../../src/common/auth/api-key-usage.tracker';
import { API_KEY_SCOPES } from '../../src/common/authz/permissions';
import { POLICY, type Policy } from '../../src/common/authz/policy.decorators';
import { MerchantsService } from '../../src/modules/merchants/merchants.service';
import { PublicSurfaceModule } from '../../src/surfaces/public/public-surface.module';
import {
  createMerchant,
  issueKey,
  rawRequest,
  startDeveloperContext,
  type DeveloperContext,
  type DeveloperMerchant,
} from '../support/developer';
import { Client } from '../support/identity';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;

beforeAll(async () => {
  ctx = await startDeveloperContext();
  merchant = await createMerchant(ctx, { active: true, label: 'keys' });
});
afterAll(async () => {
  await ctx.close();
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('key format and secrecy', () => {
  it('issues mp_{env}_{keyId}_{secret}, shows it once, and stores only the SHA-256 of the secret', async () => {
    const issued = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const match = /^mp_test_([a-z0-9]{16})_([0-9a-f]{64})$/.exec(issued.key);
    expect(match).not.toBeNull();
    const [, keyId, secret] = match as RegExpExecArray;
    const rows = await ctx.sql(
      'select secret_hash, key_id, ref from core.api_keys where ref = $1',
      [issued.ref]
    );
    expect(rows[0]).toMatchObject({ key_id: keyId, secret_hash: sha256(secret as string) });
    // The secret appears in no column of the row.
    const dump = await ctx.sql(
      'select row_to_json(k)::text as j from core.api_keys k where ref = $1',
      [issued.ref]
    );
    expect(String(dump[0]?.j)).not.toContain(secret);
    // Listing never returns it.
    const list = await merchant.owner.client.get('/dashboard/v1/api-keys');
    expect(list.body).not.toContain(secret as string);
    expect(list.body).not.toContain(issued.key);
  });

  it('generates a fresh 32-byte secret and key id for every key', async () => {
    const keys = await Promise.all(
      Array.from({ length: 5 }, () => issueKey(ctx, merchant.owner, { environment: 'test' }))
    );
    expect(new Set(keys.map((k) => k.key)).size).toBe(5);
    expect(new Set(keys.map((k) => k.key.split('_')[2])).size).toBe(5);
    expect(new Set(keys.map((k) => k.key.split('_')[3])).size).toBe(5);
  });

  it('returns the signing secret once and stores it encrypted, bound to the key', async () => {
    const issued = await issueKey(ctx, merchant.owner, { environment: 'test' });
    expect(issued.signingSecret).toMatch(/^mpsig_[0-9a-f]{64}$/);
    const rows = await ctx.sql('select signing_secret_enc from core.api_keys where ref = $1', [
      issued.ref,
    ]);
    const stored = String(rows[0]?.signing_secret_enc);
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(issued.signingSecret as string);
    const list = await merchant.owner.client.get('/dashboard/v1/api-keys');
    expect(list.body).not.toContain(issued.signingSecret as string);
    const view = list.json().data.find((k: { id: string }) => k.id === issued.ref);
    expect(view).toMatchObject({ hasSigningSecret: true, signingRequired: false });
    expect(view).not.toHaveProperty('signingSecret');
  });
});

describe('invalid keys', () => {
  const valid = () => issueKey(ctx, merchant.owner, { environment: 'test' });
  const cases: Array<[string, (key: string) => Record<string, string>]> = [
    ['no Authorization header', () => ({})],
    ['a Basic scheme', (key) => ({ authorization: `Basic ${key}` })],
    ['a lower-case bearer scheme', (key) => ({ authorization: `bearer ${key}` })],
    ['an empty token', () => ({ authorization: 'Bearer ' })],
    ['a token with spaces', (key) => ({ authorization: `Bearer ${key} extra` })],
    ['a malformed key', () => ({ authorization: 'Bearer mp_test_short_secret' })],
    ['a key with a non-hex secret', (key) => ({ authorization: `Bearer ${key.slice(0, -4)}zzzz` })],
    [
      'an unknown key id',
      (key) => ({ authorization: `Bearer ${key.replace(/_[a-z0-9]{16}_/, '_aaaaaaaaaaaaaaaa_')}` }),
    ],
    [
      'the wrong secret for a real key id',
      (key) => ({ authorization: `Bearer ${key.slice(0, -64)}${'0'.repeat(64)}` }),
    ],
    [
      'a live prefix on a test key',
      (key) => ({ authorization: `Bearer ${key.replace('mp_test_', 'mp_live_')}` }),
    ],
    ['a dashboard JWT', () => ({ authorization: `Bearer ${merchant.owner.client.token}` })],
  ];
  it.each(cases)('answers 401 UNAUTHORIZED to %s', async (_label, headers) => {
    const issued = await valid();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/payments',
      remoteAddress: '10.2.2.2',
      headers: headers(issued.key),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    // Nothing distinguishes the reasons (no oracle for key ids or secrets).
    expect(res.json().error).not.toHaveProperty('details');
  });

  it('remembers an unknown key id for 30 seconds so guesses do not reach Postgres', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/ping',
      remoteAddress: '10.2.2.3',
      headers: { authorization: `Bearer mp_test_neverissued00001_${'a'.repeat(64)}` },
    });
    expect(res.statusCode).toBe(401);
    const redis = ctx.app.get(ApiKeyCache, { strict: false });
    expect(await redis.lookup('neverissued00001')).toEqual({ kind: 'negative' });
  });

  it('expired keys are refused, judged on every request even when cached', async () => {
    const issued = await issueKey(ctx, merchant.owner, { environment: 'test' });
    expect((await issued.client.get('/v1/ping')).statusCode).toBe(200);
    await ctx.sql(
      "update core.api_keys set expires_at = now() + interval '1 hour' where ref = $1",
      [issued.ref]
    );
    const cache = ctx.app.get(ApiKeyCache, { strict: false });
    await cache.evict(issued.key.split('_')[2] as string);
    expect((await issued.client.get('/v1/ping')).statusCode).toBe(200);
    ctx.clock.advanceBy(2 * 3_600_000);
    expect((await issued.client.get('/v1/ping')).statusCode).toBe(401);
    ctx.clock.advanceBy(-2 * 3_600_000);
  });
});

describe('revocation and the cache', () => {
  it('a revoked key stops working at once, though its entry was cached', async () => {
    const issued = await issueKey(ctx, merchant.owner, { environment: 'test' });
    expect((await issued.client.get('/v1/ping')).statusCode).toBe(200);
    expect(
      await ctx.app.get(ApiKeyCache, { strict: false }).lookup(issued.key.split('_')[2] as string)
    ).toMatchObject({ kind: 'hit' });
    const revoked = await merchant.owner.client.delete(`/dashboard/v1/api-keys/${issued.ref}`);
    expect(revoked.statusCode).toBe(200);
    const after = await issued.client.get('/v1/ping');
    expect(after.statusCode).toBe(401);
    expect(
      (await ctx.sql('select revoked_at from core.api_keys where ref = $1', [issued.ref]))[0]
        ?.revoked_at
    ).not.toBeNull();
  });

  it('is immediate on every replica: another app instance sharing Redis refuses the key', async () => {
    const other = await startDeveloperContext();
    try {
      const issued = await issueKey(ctx, merchant.owner, { environment: 'test' });
      const onOther = new Client(other.app);
      onOther.token = issued.key;
      expect((await onOther.get('/v1/ping')).statusCode).toBe(200);
      await merchant.owner.client.delete(`/dashboard/v1/api-keys/${issued.ref}`);
      expect((await onOther.get('/v1/ping')).statusCode).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('discards an entry cached from a database read that began before the eviction', async () => {
    const issued = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const keyId = issued.key.split('_')[2] as string;
    const cache = ctx.app.get(ApiKeyCache, { strict: false });
    expect((await issued.client.get('/v1/ping')).statusCode).toBe(200);
    const hit = await cache.lookup(keyId);
    expect(hit.kind).toBe('hit');
    if (hit.kind !== 'hit') return;
    // A slow reader read the row, a revocation committed and evicted, and then the reader
    // wrote its (now stale) entry. It carries the time its read began, which precedes the
    // eviction marker, so the entry is not honoured.
    await cache.evict(keyId);
    await cache.put({ ...hit.key, readAtMs: hit.key.readAtMs - 5 });
    expect(await cache.lookup(keyId)).toEqual({ kind: 'miss' });
  });

  it('a merchant lifecycle change evicts every key of the merchant', async () => {
    const owner = await createMerchant(ctx, { active: true, label: 'suspend' });
    const live = await issueKey(ctx, owner.owner, {
      environment: 'live',
      scopes: ['payments:read', 'payments:write'],
    });
    const body = {
      amountMinor: '5000',
      currency: 'UGX',
      paymentMethod: { msisdn: '+256700000001' },
    };
    expect(
      (await live.client.post('/v1/payments', body, { 'idempotency-key': 'a-1' })).statusCode
    ).toBe(201);
    await ctx.app.get(MerchantsService, { strict: false }).transition(owner.ref, 'suspend', 'test');
    const refused = await live.client.post('/v1/payments', body, { 'idempotency-key': 'a-2' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('MERCHANT_NOT_ACTIVE');
  });
});

describe('rotation (grace period 0 to 7 days)', () => {
  async function roll(ref: string, gracePeriodHours?: number) {
    return merchant.owner.client.post(
      `/dashboard/v1/api-keys/${ref}/roll`,
      gracePeriodHours === undefined ? {} : { gracePeriodHours }
    );
  }

  it('keeps both keys valid during the grace period and retires the old one after it', async () => {
    const old = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
      rateLimitRpm: 77,
    });
    expect((await old.client.get('/v1/ping')).statusCode).toBe(200);
    const res = await roll(old.ref, 24);
    expect(res.statusCode).toBe(201);
    const fresh = res.json().data;
    expect(fresh.key).not.toBe(old.key);
    expect(fresh).toMatchObject({ scopes: ['payments:read'], rateLimitRpm: 77, status: 'active' });
    expect(fresh.signingSecret).toMatch(/^mpsig_/);
    expect(fresh.signingSecret).not.toBe(old.signingSecret);
    const next = new Client(ctx.app);
    next.token = fresh.key;
    expect((await next.get('/v1/ping')).statusCode).toBe(200);
    expect((await old.client.get('/v1/ping')).statusCode).toBe(200);
    const oldRow = await ctx.sql('select expires_at from core.api_keys where ref = $1', [old.ref]);
    const hours =
      (new Date(oldRow[0]?.expires_at as string).getTime() - ctx.clock.now().getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    ctx.clock.advanceBy(25 * 3_600_000);
    expect((await old.client.get('/v1/ping')).statusCode).toBe(401);
    expect((await next.get('/v1/ping')).statusCode).toBe(200);
    ctx.clock.advanceBy(-25 * 3_600_000);
  });

  it('with no grace period the old key is revoked at once', async () => {
    const old = await issueKey(ctx, merchant.owner, { environment: 'test' });
    expect((await old.client.get('/v1/ping')).statusCode).toBe(200);
    expect((await roll(old.ref, 0)).statusCode).toBe(201);
    expect((await old.client.get('/v1/ping')).statusCode).toBe(401);
    const row = await ctx.sql('select revoked_at from core.api_keys where ref = $1', [old.ref]);
    expect(row[0]?.revoked_at).not.toBeNull();
  });

  it('accepts a grace period from 0 to 7 days and refuses the rest', async () => {
    const seven = await issueKey(ctx, merchant.owner, { environment: 'test' });
    expect((await roll(seven.ref, 168)).statusCode).toBe(201);
    for (const bad of [169, -1, 1.5, 100_000]) {
      const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
      const res = await roll(key.ref, bad);
      expect(res.statusCode, String(bad)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rolls a key once, and never a revoked key', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    expect((await roll(key.ref, 1)).statusCode).toBe(201);
    expect((await roll(key.ref, 1)).statusCode).toBe(409);
    const revoked = await issueKey(ctx, merchant.owner, { environment: 'test' });
    await merchant.owner.client.delete(`/dashboard/v1/api-keys/${revoked.ref}`);
    expect((await roll(revoked.ref)).statusCode).toBe(409);
    expect((await roll('ak_01JBX7Q2M4N8R5T6V9W0XYZABC')).statusCode).toBe(404);
  });

  it('reports the status of each key', async () => {
    const active = await issueKey(ctx, merchant.owner, { environment: 'test', name: 'status-a' });
    const revoked = await issueKey(ctx, merchant.owner, { environment: 'test', name: 'status-r' });
    await merchant.owner.client.delete(`/dashboard/v1/api-keys/${revoked.ref}`);
    const list = (await merchant.owner.client.get('/dashboard/v1/api-keys')).json().data as Array<{
      id: string;
      status: string;
    }>;
    expect(list.find((k) => k.id === active.ref)?.status).toBe('active');
    expect(list.find((k) => k.id === revoked.ref)?.status).toBe('revoked');
  });
});

describe('merchant association', () => {
  it("a key acts only on its own merchant's data, and a test key never sees live data", async () => {
    const other = await createMerchant(ctx, { active: true, label: 'other' });
    const mine = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['payments:write', 'payments:read'],
    });
    const theirs = await issueKey(ctx, other.owner, {
      environment: 'live',
      scopes: ['payments:write', 'payments:read'],
    });
    const created = await mine.client.post(
      '/v1/payments',
      { amountMinor: '7000', currency: 'UGX', paymentMethod: { msisdn: '+256700000002' } },
      { 'idempotency-key': 'merchant-iso-1' }
    );
    expect(created.statusCode).toBe(201);
    const ref = created.json().data.id as string;
    expect((await mine.client.get(`/v1/payments/${ref}`)).statusCode).toBe(200);
    const foreign = await theirs.client.get(`/v1/payments/${ref}`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('NOT_FOUND');
    const testKey = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
    });
    expect((await testKey.client.get(`/v1/payments/${ref}`)).statusCode).toBe(404);
    expect((await testKey.client.get('/v1/payments')).json().data.items).toEqual([]);
  });
});

describe('scopes', () => {
  /** Every route of the public surface and the scope it needs, with a request that passes validation. */
  const ROUTES: Array<[string, string, string, unknown?]> = [
    ['GET', '/v1/payments', 'payments:read'],
    ['GET', '/v1/payments/pay_01JBX7Q2M4N8R5T6V9W0XYZABC', 'payments:read'],
    ['GET', '/v1/payments/pay_01JBX7Q2M4N8R5T6V9W0XYZABC/timeline', 'payments:read'],
    ['POST', '/v1/payments/pay_01JBX7Q2M4N8R5T6V9W0XYZABC/cancel', 'payments:write', {}],
    ['GET', '/v1/payment-links', 'payments:read'],
    ['GET', '/v1/payment-links/pl_01JBX7Q2M4N8R5T6V9W0XYZABC', 'payments:read'],
    ['POST', '/v1/payment-links/pl_01JBX7Q2M4N8R5T6V9W0XYZABC/deactivate', 'payments:write', {}],
    ['GET', '/v1/checkout-sessions/cs_01JBX7Q2M4N8R5T6V9W0XYZABC', 'payments:read'],
    ['POST', '/v1/checkout-sessions/cs_01JBX7Q2M4N8R5T6V9W0XYZABC/expire', 'payments:write', {}],
    ['GET', '/v1/transactions', 'transactions:read'],
    ['GET', '/v1/transactions/txn_01JBX7Q2M4N8R5T6V9W0XYZABC', 'transactions:read'],
    ['GET', '/v1/balances', 'balances:read'],
    ['GET', '/v1/balance-transactions', 'balances:read'],
    ['GET', '/v1/holds', 'balances:read'],
    ['GET', '/v1/events', 'events:read'],
    ['GET', '/v1/events/evt_01JBX7Q2M4N8R5T6V9W0XYZABC', 'events:read'],
    ['GET', '/v1/webhook-endpoints', 'webhooks:read'],
    ['GET', '/v1/webhook-endpoints/wh_01JBX7Q2M4N8R5T6V9W0XYZABC', 'webhooks:read'],
    ['DELETE', '/v1/webhook-endpoints/wh_01JBX7Q2M4N8R5T6V9W0XYZABC', 'webhooks:write'],
    [
      'POST',
      '/v1/webhook-endpoints/wh_01JBX7Q2M4N8R5T6V9W0XYZABC/rotate-secret',
      'webhooks:write',
      {},
    ],
    ['POST', '/v1/__probe/payouts', 'payouts:write', {}],
    ['POST', '/v1/__probe/refunds', 'refunds:write', {}],
  ];

  it('every route of the public surface needs a defined scope, except ping and the status feed', () => {
    const module = [...ctx.app.get(ModulesContainer).values()].find(
      (m) => m.metatype === PublicSurfaceModule
    );
    expect(module).toBeDefined();
    const missing: string[] = [];
    for (const wrapper of module?.controllers.values() ?? []) {
      const controller = wrapper.metatype as (new () => unknown) | null;
      if (!controller) continue;
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (
          typeof handler !== 'function' ||
          Reflect.getMetadata(PATH_METADATA, handler) === undefined
        )
          continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const policy = Reflect.getMetadata(POLICY, handler) as Policy | undefined;
        const id = `${controller.name}.${name}`;
        if (controller.name === 'PingController') continue;
        // The status feed is public on purpose (spec 6.12): it must say so, and nothing else may.
        if (id === 'StatusController.status') {
          expect(policy).toEqual({ kind: 'public' });
          continue;
        }
        if (
          policy?.kind !== 'permission' ||
          !(API_KEY_SCOPES as readonly string[]).includes(policy.permission)
        ) {
          missing.push(id);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it.each(ROUTES)(
    '%s %s needs %s: a valid key without it gets 403, never the data',
    async (method, url, scope, body) => {
      const others = API_KEY_SCOPES.filter((s) => s !== scope);
      const key = await issueKey(ctx, merchant.owner, {
        environment: 'test',
        scopes: others.slice(0, 15),
      });
      const res = await rawRequest(ctx, {
        method: method as 'GET',
        url,
        key: key.key,
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  );

  it.each(ROUTES.filter(([, , , body]) => body === undefined))(
    '%s %s with exactly %s is allowed through (404 for an unknown id, never 403)',
    async (method, url, scope) => {
      const key = await issueKey(ctx, merchant.owner, { environment: 'test', scopes: [scope] });
      const res = await rawRequest(ctx, { method: method as 'GET', url, key: key.key });
      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).not.toBe(401);
    }
  );

  it('read scopes do not grant writes, and write scopes do not grant reads', async () => {
    const reader = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
    });
    const writer = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:write'],
    });
    const body = {
      amountMinor: '1000',
      currency: 'UGX',
      paymentMethod: { msisdn: '+256700000003' },
    };
    expect(
      (await reader.client.post('/v1/payments', body, { 'idempotency-key': 'scope-1' })).statusCode
    ).toBe(403);
    expect((await writer.client.get('/v1/payments')).statusCode).toBe(403);
    expect(
      (await writer.client.post('/v1/payments', body, { 'idempotency-key': 'scope-2' })).statusCode
    ).toBe(201);
  });

  it('refuses to issue a key with a scope that does not exist, so none can be forged', async () => {
    const res = await merchant.owner.client.post('/dashboard/v1/api-keys', {
      name: 'bad',
      environment: 'test',
      scopes: ['payments:read', 'admin:everything'],
    });
    expect(res.statusCode).toBe(400);
  });

  it('a request with a valid key but a scope the key lacks is not audited as success and writes nothing', async () => {
    const reader = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
    });
    const before = await ctx.sql(
      'select count(*)::int as n from core.payments where merchant_id = $1',
      [merchant.id]
    );
    const res = await reader.client.post(
      '/v1/payments',
      { amountMinor: '1000', currency: 'UGX', paymentMethod: { msisdn: '+256700000004' } },
      { 'idempotency-key': 'scope-3' }
    );
    expect(res.statusCode).toBe(403);
    const after = await ctx.sql(
      'select count(*)::int as n from core.payments where merchant_id = $1',
      [merchant.id]
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    const denied = await ctx.sql(
      "select outcome from core.audit_logs where merchant_id = $1 and outcome = 'denied' and action = 'payment.created'",
      [merchant.id]
    );
    expect(denied.length).toBeGreaterThan(0);
  });
});

describe('IP allowlist', () => {
  it('lets the listed network in and refuses every other address', async () => {
    const key = await issueKey(ctx, merchant.owner, { ipAllowlist: ['203.0.113.0/24'] });
    for (const [ip, expected] of [
      ['203.0.113.7', 200],
      ['203.0.113.255', 200],
      ['203.0.114.7', 401],
      ['198.51.100.9', 401],
      ['127.0.0.1', 401],
    ] as const) {
      const res = await rawRequest(ctx, {
        method: 'GET',
        url: '/v1/ping',
        key: key.key,
        remoteAddress: ip,
      });
      expect(res.statusCode, ip).toBe(expected);
    }
  });

  it('supports single addresses and IPv6', async () => {
    const key = await issueKey(ctx, merchant.owner, {
      ipAllowlist: ['198.51.100.9/32', '2001:db8:aaaa::/48'],
    });
    for (const [ip, expected] of [
      ['198.51.100.9', 200],
      ['198.51.100.10', 401],
      ['2001:db8:aaaa:1::5', 200],
      ['2001:db8:bbbb::1', 401],
    ] as const) {
      const res = await rawRequest(ctx, {
        method: 'GET',
        url: '/v1/ping',
        key: key.key,
        remoteAddress: ip,
      });
      expect(res.statusCode, ip).toBe(expected);
    }
  });

  it('matches an IPv4 entry against the IPv4-mapped form a dual-stack socket reports', async () => {
    const key = await issueKey(ctx, merchant.owner, { ipAllowlist: ['203.0.113.0/24'] });
    const res = await rawRequest(ctx, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      remoteAddress: '::ffff:203.0.113.20',
    });
    expect(res.statusCode).toBe(200);
  });

  it('ignores every forwarding header when no proxy is trusted: a spoofed address buys nothing', async () => {
    const key = await issueKey(ctx, merchant.owner, { ipAllowlist: ['203.0.113.0/24'] });
    const spoofs: Array<Record<string, string>> = [
      { 'x-forwarded-for': '203.0.113.5' },
      { 'x-forwarded-for': '203.0.113.5, 203.0.113.6' },
      { 'x-real-ip': '203.0.113.5' },
      { forwarded: 'for=203.0.113.5' },
      { 'cf-connecting-ip': '203.0.113.5' },
      { 'true-client-ip': '203.0.113.5' },
      { 'x-client-ip': '203.0.113.5' },
      { 'x-forwarded-host': '203.0.113.5' },
    ];
    for (const headers of spoofs) {
      const res = await rawRequest(ctx, {
        method: 'GET',
        url: '/v1/ping',
        key: key.key,
        remoteAddress: '198.51.100.9',
        headers,
      });
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
    }
  });
});

describe('IP allowlist behind trusted proxies (TRUST_PROXY)', () => {
  let proxied: DeveloperContext;
  let owner: DeveloperMerchant;
  beforeAll(async () => {
    proxied = await startDeveloperContext({ TRUST_PROXY: '10.9.8.0/24' });
    owner = await createMerchant(proxied, { label: 'proxied' });
  });
  afterAll(async () => {
    await proxied.close();
  });

  it('takes the client address from X-Forwarded-For when the connection is from a trusted proxy', async () => {
    const key = await issueKey(proxied, owner.owner, { ipAllowlist: ['203.0.113.0/24'] });
    const res = await rawRequest(proxied, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      remoteAddress: '10.9.8.7',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('uses the address the proxy appended, not the ones the client wrote in front of it', async () => {
    const key = await issueKey(proxied, owner.owner, { ipAllowlist: ['203.0.113.0/24'] });
    // The client claims to be 203.0.113.5; the proxy saw it connect from 198.51.100.9.
    const res = await rawRequest(proxied, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      remoteAddress: '10.9.8.7',
      headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.9' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not trust a forwarding header from a connection that is not a trusted proxy', async () => {
    const key = await issueKey(proxied, owner.owner, { ipAllowlist: ['203.0.113.0/24'] });
    const res = await rawRequest(proxied, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      remoteAddress: '192.0.2.50',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('trusts a chain of trusted proxies and stops at the first untrusted address', async () => {
    const key = await issueKey(proxied, owner.owner, { ipAllowlist: ['203.0.113.0/24'] });
    const ok = await rawRequest(proxied, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      remoteAddress: '10.9.8.7',
      headers: { 'x-forwarded-for': '203.0.113.5, 10.9.8.200' },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('last_used_at', () => {
  it('is recorded in Redis on the request and written to Postgres by the flush, not by the request', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    expect((await key.client.get('/v1/ping')).statusCode).toBe(200);
    const row = () => ctx.sql('select last_used_at from core.api_keys where ref = $1', [key.ref]);
    expect((await row())[0]?.last_used_at).toBeNull();
    // The touch is fire and forget; give it a moment, then flush as the worker does.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const flushed = await ctx.app.get(ApiKeyUsageTracker, { strict: false }).flush();
    expect(flushed).toBeGreaterThan(0);
    expect((await row())[0]?.last_used_at).not.toBeNull();
    // A second flush has nothing left for this key.
    await ctx.app.get(ApiKeyUsageTracker, { strict: false }).flush();
    const view = (await merchant.owner.client.get('/dashboard/v1/api-keys'))
      .json()
      .data.find((k: { id: string }) => k.id === key.ref);
    expect(view.lastUsedAt).not.toBeNull();
  });
});
