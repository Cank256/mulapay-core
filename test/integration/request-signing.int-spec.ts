/**
 * Request signing (spec 6.11): mandatory for live `payouts:write` keys, optional elsewhere.
 * HMAC-SHA256 over `timestamp.METHOD.path.sha256(rawBody)`, 300-second tolerance, replay
 * protection in Redis. The payout route does not exist until Phase 4, so the rule is proven
 * on a probe route that needs `payouts:write`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKeyCache } from '../../src/common/auth/api-key-cache';
import { REDIS } from '../../src/common/redis/redis.module';
import { Client } from '../support/identity';
import {
  createMerchant,
  issueKey,
  rawRequest,
  signedHeaders,
  startDeveloperContext,
  type DeveloperContext,
  type DeveloperMerchant,
  type IssuedKey,
} from '../support/developer';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;
let payoutKey: IssuedKey;

const PAYOUT_URL = '/v1/__probe/payouts';
const BODY = JSON.stringify({ amountMinor: '5000', currency: 'UGX' });
const nowSeconds = () => Math.floor(ctx.clock.now().getTime() / 1000);

beforeAll(async () => {
  ctx = await startDeveloperContext();
  merchant = await createMerchant(ctx, { active: true, label: 'signing' });
  payoutKey = await issueKey(ctx, merchant.owner, {
    environment: 'live',
    scopes: ['payouts:write', 'payments:read'],
  });
});
afterAll(async () => {
  await ctx.close();
});

/**
 * Two identical requests signed in the same second have the same signature, and the second is
 * a replay by design. Each helper call therefore sends a body of its own.
 */
let counter = 0;
const uniqueBody = () =>
  JSON.stringify({ amountMinor: '5000', currency: 'UGX', n: (counter += 1) });

function signedPayout(
  key: IssuedKey,
  overrides: {
    payload?: string;
    url?: string;
    method?: string;
    timestamp?: number;
    secret?: string;
  } = {}
) {
  const payload = overrides.payload ?? uniqueBody();
  const url = overrides.url ?? PAYOUT_URL;
  return rawRequest(ctx, {
    method: 'POST',
    url,
    key: key.key,
    payload,
    headers: signedHeaders(overrides.secret ?? (key.signingSecret as string), {
      method: overrides.method ?? 'POST',
      url,
      payload,
      timestamp: overrides.timestamp ?? nowSeconds(),
    }),
  });
}

describe('mandatory signing for live payouts:write keys', () => {
  it('forces signing on at issue, whatever the request asked', async () => {
    const view = (await merchant.owner.client.get('/dashboard/v1/api-keys'))
      .json()
      .data.find((k: { id: string }) => k.id === payoutKey.ref);
    expect(view).toMatchObject({
      signingRequired: true,
      hasSigningSecret: true,
      environment: 'live',
    });
  });

  it('refuses an unsigned request', async () => {
    const res = await rawRequest(ctx, {
      method: 'POST',
      url: PAYOUT_URL,
      key: payoutKey.key,
      payload: BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SIGNATURE_REQUIRED');
  });

  it('refuses a request with only one of the two headers', async () => {
    const headers = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
      timestamp: nowSeconds(),
    });
    const halves: Array<Record<string, string>> = [
      { 'x-mulapay-timestamp': headers['x-mulapay-timestamp'] as string },
      { 'x-mulapay-signature': headers['x-mulapay-signature'] as string },
    ];
    for (const only of halves) {
      const res = await rawRequest(ctx, {
        method: 'POST',
        url: PAYOUT_URL,
        key: payoutKey.key,
        payload: BODY,
        headers: only,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SIGNATURE_REQUIRED');
    }
  });

  it('accepts a correctly signed request', async () => {
    const res = await signedPayout(payoutKey);
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toEqual({ ok: true, bytes: 0 });
  });

  it('is not required on a test key, even with payouts:write', async () => {
    const testKey = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payouts:write'],
    });
    const res = await rawRequest(ctx, {
      method: 'POST',
      url: PAYOUT_URL,
      key: testKey.key,
      payload: BODY,
    });
    expect(res.statusCode).toBe(201);
  });

  it('applies to every request of such a key, so a stolen key alone reads nothing either', async () => {
    const unsigned = await payoutKey.client.get('/v1/ping');
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error.code).toBe('SIGNATURE_REQUIRED');
    const signed = await rawRequest(ctx, {
      method: 'GET',
      url: '/v1/ping',
      key: payoutKey.key,
      headers: signedHeaders(payoutKey.signingSecret as string, {
        method: 'GET',
        url: '/v1/ping',
        timestamp: nowSeconds(),
      }),
    });
    expect(signed.statusCode).toBe(200);
  });

  it('does not make other live scopes require signing', async () => {
    const refunds = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['refunds:write'],
    });
    const res = await rawRequest(ctx, {
      method: 'POST',
      url: '/v1/__probe/refunds',
      key: refunds.key,
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
  });

  it('a key that predates signing secrets cannot satisfy the rule and is told to roll', async () => {
    const legacy = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['payouts:write'],
    });
    await ctx.sql(
      'update core.api_keys set signing_required = false, signing_secret_enc = null where ref = $1',
      [legacy.ref]
    );
    await ctx.app.get(ApiKeyCache, { strict: false }).evict(legacy.key.split('_')[2] as string);
    const res = await signedPayout(legacy, { secret: 'mpsig_anything' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SIGNING_SECRET_MISSING');
  });

  it('a rolled key keeps the requirement, gets a new signing secret, and the old secret stops working', async () => {
    const key = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['payouts:write'],
    });
    const rolled = (
      await merchant.owner.client.post(`/dashboard/v1/api-keys/${key.ref}/roll`, {
        gracePeriodHours: 1,
      })
    ).json().data;
    expect(rolled.signingRequired).toBe(true);
    const fresh = new Client(ctx.app);
    fresh.token = rolled.key;
    const next: IssuedKey = {
      key: rolled.key,
      ref: rolled.id,
      signingSecret: rolled.signingSecret,
      client: fresh,
    };
    expect((await signedPayout(next)).statusCode).toBe(201);
    // The old key's secret does not sign for the new key.
    const stale = await signedPayout(next, { secret: key.signingSecret as string });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('SIGNATURE_INVALID');
  });
});

describe('optional signing on any key', () => {
  it('a key issued with signingRequired must sign every request', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test', signingRequired: true });
    const unsigned = await key.client.get('/v1/ping');
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().error.code).toBe('SIGNATURE_REQUIRED');
    const ok = await rawRequest(ctx, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      headers: signedHeaders(key.signingSecret as string, {
        method: 'GET',
        url: '/v1/ping',
        timestamp: nowSeconds(),
      }),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('a signature that is present is always checked, even when the key does not require one', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const bad = await rawRequest(ctx, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      headers: {
        'x-mulapay-timestamp': String(nowSeconds()),
        'x-mulapay-signature': `v1=${'0'.repeat(64)}`,
      },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('SIGNATURE_INVALID');
    const half = await rawRequest(ctx, {
      method: 'GET',
      url: '/v1/ping',
      key: key.key,
      headers: { 'x-mulapay-timestamp': String(nowSeconds()) },
    });
    expect(half.json().error.code).toBe('SIGNATURE_REQUIRED');
  });

  it('signs GET requests with no body, and covers the query string', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test', signingRequired: true });
    const url = '/v1/payments?limit=5&status=created';
    const ok = await rawRequest(ctx, {
      method: 'GET',
      url,
      key: key.key,
      headers: signedHeaders(key.signingSecret as string, {
        method: 'GET',
        url,
        timestamp: nowSeconds(),
      }),
    });
    expect(ok.statusCode).toBe(200);
    const tampered = await rawRequest(ctx, {
      method: 'GET',
      url: '/v1/payments?limit=100&status=created',
      key: key.key,
      headers: signedHeaders(key.signingSecret as string, {
        method: 'GET',
        url,
        timestamp: nowSeconds(),
      }),
    });
    expect(tampered.json().error.code).toBe('SIGNATURE_INVALID');
  });
});

describe('invalid signatures', () => {
  it('rejects a changed body', async () => {
    const headers = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
      timestamp: nowSeconds(),
    });
    const res = await rawRequest(ctx, {
      method: 'POST',
      url: PAYOUT_URL,
      key: payoutKey.key,
      payload: '{"amountMinor":"999999","currency":"UGX"}',
      headers,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SIGNATURE_INVALID');
  });

  it('rejects a signature made for another query, method or timestamp', async () => {
    const variants: Array<{ method: string; url: string; signedAt: number; headerAt: number }> = [
      { method: 'POST', url: `${PAYOUT_URL}?x=1`, signedAt: nowSeconds(), headerAt: nowSeconds() },
      { method: 'PUT', url: PAYOUT_URL, signedAt: nowSeconds(), headerAt: nowSeconds() },
      { method: 'POST', url: PAYOUT_URL, signedAt: nowSeconds() - 5, headerAt: nowSeconds() },
    ];
    for (const variant of variants) {
      const headers = signedHeaders(payoutKey.signingSecret as string, {
        method: variant.method,
        url: variant.url,
        payload: BODY,
        timestamp: variant.signedAt,
      });
      const res = await rawRequest(ctx, {
        method: 'POST',
        url: PAYOUT_URL,
        key: payoutKey.key,
        payload: BODY,
        headers: { ...headers, 'x-mulapay-timestamp': String(variant.headerAt) },
      });
      expect(res.statusCode, JSON.stringify(variant)).toBe(401);
      expect(res.json().error.code).toBe('SIGNATURE_INVALID');
    }
  });

  it('rejects the API key secret, another key’s signing secret and a guess', async () => {
    const other = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['payouts:write'],
    });
    for (const secret of [payoutKey.key, other.signingSecret as string, 'mpsig_guess']) {
      const res = await signedPayout(payoutKey, { secret });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SIGNATURE_INVALID');
    }
  });

  it.each([
    ['no v1= prefix', (mac: string) => mac],
    ['an unknown version', (mac: string) => `v2=${mac}`],
    ['upper-case hex', (mac: string) => `v1=${mac.toUpperCase()}`],
    ['a truncated MAC', (mac: string) => `v1=${mac.slice(0, 60)}`],
    ['a padded MAC', (mac: string) => `v1=${mac}00`],
    ['non-hex characters', (mac: string) => `v1=${mac.slice(0, 63)}z`],
    ['a leading space', (mac: string) => ` v1=${mac}`],
    ['two signatures', (mac: string) => `v1=${mac},v1=${mac}`],
    ['an empty value', () => ''],
  ])('rejects a malformed header: %s', async (_label, mutate) => {
    const good = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
      timestamp: nowSeconds(),
    });
    const mac = (good['x-mulapay-signature'] as string).slice(3);
    const res = await rawRequest(ctx, {
      method: 'POST',
      url: PAYOUT_URL,
      key: payoutKey.key,
      payload: BODY,
      headers: {
        'x-mulapay-timestamp': good['x-mulapay-timestamp'] as string,
        'x-mulapay-signature': mutate(mac),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(['SIGNATURE_INVALID', 'SIGNATURE_REQUIRED']).toContain(res.json().error.code);
  });

  it('does not say which part differed', async () => {
    const wrongSecret = await signedPayout(payoutKey, { secret: 'mpsig_wrong' });
    const wrongBody = await signedPayout(payoutKey, { payload: '{}', secret: 'mpsig_wrong' });
    expect(wrongSecret.json().error.message).toBe(wrongBody.json().error.message);
    expect(wrongSecret.json().error).not.toHaveProperty('details');
  });
});

describe('timestamp tolerance (300 seconds)', () => {
  it('accepts a timestamp within 300 seconds in either direction', async () => {
    for (const skew of [0, 299, 300, -299, -300]) {
      const res = await signedPayout(payoutKey, { timestamp: nowSeconds() + skew });
      expect(res.statusCode, `${skew} ${res.body}`).toBe(201);
    }
  });

  it('rejects an expired timestamp and one from the future', async () => {
    for (const skew of [301, -301, 3600, -86_400, 10 ** 9]) {
      const res = await signedPayout(payoutKey, { timestamp: nowSeconds() + skew });
      expect(res.statusCode, String(skew)).toBe(401);
      expect(res.json().error.code).toBe('SIGNATURE_TIMESTAMP_INVALID');
    }
  });

  it('rejects a timestamp that is not whole seconds in digits', async () => {
    const good = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
    });
    for (const bad of ['abc', '-5', '1.5', '1e9', '0x10', ' 5', '99999999999999999999']) {
      const res = await rawRequest(ctx, {
        method: 'POST',
        url: PAYOUT_URL,
        key: payoutKey.key,
        payload: BODY,
        headers: {
          'x-mulapay-timestamp': bad,
          'x-mulapay-signature': good['x-mulapay-signature'] as string,
        },
      });
      expect(res.statusCode, bad).toBe(401);
      expect(res.json().error.code).toBe('SIGNATURE_TIMESTAMP_INVALID');
    }
  });

  it('follows the clock: a signature goes stale as time passes', async () => {
    const stamp = nowSeconds();
    expect((await signedPayout(payoutKey, { timestamp: stamp })).statusCode).toBe(201);
    ctx.clock.advanceBy(301_000);
    const stale = await signedPayout(payoutKey, { timestamp: stamp });
    expect(stale.json().error.code).toBe('SIGNATURE_TIMESTAMP_INVALID');
    ctx.clock.advanceBy(-301_000);
  });
});

describe('replay protection', () => {
  it('accepts a signature once and refuses the same request again', async () => {
    const headers = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
      timestamp: nowSeconds() - 1,
    });
    const send = () =>
      rawRequest(ctx, {
        method: 'POST',
        url: PAYOUT_URL,
        key: payoutKey.key,
        payload: BODY,
        headers,
      });
    expect((await send()).statusCode).toBe(201);
    const replay = await send();
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('SIGNATURE_REPLAYED');
    expect((await send()).json().error.code).toBe('SIGNATURE_REPLAYED');
  });

  it('refuses a replay arriving concurrently: exactly one of many identical requests succeeds', async () => {
    const headers = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
      timestamp: nowSeconds() - 2,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rawRequest(ctx, {
          method: 'POST',
          url: PAYOUT_URL,
          key: payoutKey.key,
          payload: BODY,
          headers,
        })
      )
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.json().error?.code === 'SIGNATURE_REPLAYED')).toHaveLength(19);
  });

  it('remembers the signature for the whole window it could verify in, twice the tolerance', async () => {
    const stamp = nowSeconds() - 3;
    const headers = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
      timestamp: stamp,
    });
    await rawRequest(ctx, {
      method: 'POST',
      url: PAYOUT_URL,
      key: payoutKey.key,
      payload: BODY,
      headers,
    });
    const redis = ctx.app.get<Redis>(REDIS, { strict: false });
    const mac = (headers['x-mulapay-signature'] as string).slice(3);
    const keys = await redis.keys(`sigreplay:*:${mac}`);
    expect(keys).toHaveLength(1);
    const ttl = await redis.ttl(keys[0] as string);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(605);
  });

  it('a failed verification does not use up the genuine signature', async () => {
    const headers = signedHeaders(payoutKey.signingSecret as string, {
      method: 'POST',
      url: PAYOUT_URL,
      payload: BODY,
      timestamp: nowSeconds() - 4,
    });
    // An attacker who saw the headers (but not the body) cannot burn them with a wrong body.
    const forged = await rawRequest(ctx, {
      method: 'POST',
      url: PAYOUT_URL,
      key: payoutKey.key,
      payload: '{"amountMinor":"1","currency":"UGX"}',
      headers,
    });
    expect(forged.json().error.code).toBe('SIGNATURE_INVALID');
    const genuine = await rawRequest(ctx, {
      method: 'POST',
      url: PAYOUT_URL,
      key: payoutKey.key,
      payload: BODY,
      headers,
    });
    expect(genuine.statusCode).toBe(201);
  });

  it('keeps replay records per key', async () => {
    const other = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['payouts:write'],
    });
    const a = await signedPayout(payoutKey, { timestamp: nowSeconds() - 5 });
    const b = await signedPayout(other, { timestamp: nowSeconds() - 5 });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
  });
});

describe('constant-time comparison', () => {
  it('compares MACs, webhook signatures and key hashes with timingSafeEqual', () => {
    const root = join(__dirname, '../../src');
    for (const file of [
      'common/auth/request-signing.ts',
      'modules/webhooks/domain/webhook-signature.ts',
      'modules/api-keys/api-key-authenticator.service.ts',
    ]) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).toMatch(/timingSafeEqual\(/);
      expect(source, file).not.toMatch(/(signature|mac|hash)\s*===\s*/i);
    }
  });
});
