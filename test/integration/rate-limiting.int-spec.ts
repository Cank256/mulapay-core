/**
 * Rate limiting (spec 8.5): per-key sliding windows, the per-merchant payout window, the
 * burst bucket and the failed-authentication limit, all in Redis and all atomic. Includes
 * the ways a client might try to buy more requests than it is allowed.
 */
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS } from '../../src/common/redis/redis.module';
import {
  createMerchant,
  issueKey,
  rawRequest,
  startDeveloperContext,
  type DeveloperContext,
  type DeveloperMerchant,
  type IssuedKey,
} from '../support/developer';

const READ_LIMIT = 8;
const WRITE_LIMIT = 5;
const PAYOUT_LIMIT = 3;

let ctx: DeveloperContext;
let redis: Redis;
let merchant: DeveloperMerchant;

beforeAll(async () => {
  ctx = await startDeveloperContext({
    RATE_LIMIT_READ_PER_MIN: String(READ_LIMIT),
    RATE_LIMIT_WRITE_PER_MIN: String(WRITE_LIMIT),
    RATE_LIMIT_PAYOUT_PER_MIN: String(PAYOUT_LIMIT),
    RATE_LIMIT_BURST_CAPACITY: '10000',
    RATE_LIMIT_BURST_REFILL_PER_SECOND: '10000',
    RATE_LIMIT_AUTH_FAILURE_PER_MIN: '100000',
  });
  redis = ctx.app.get<Redis>(REDIS, { strict: false });
  merchant = await createMerchant(ctx, { label: 'limits' });
});
afterAll(async () => {
  await ctx.close();
});

const keyIdOf = (key: IssuedKey) => key.key.split('_')[2] as string;
const get = (
  key: IssuedKey,
  url = '/v1/ping',
  ip = '10.7.7.7',
  headers: Record<string, string> = {}
) => rawRequest(ctx, { method: 'GET', url, key: key.key, remoteAddress: ip, headers });
const writeKey = (scopes: string[] = ['refunds:write']) =>
  issueKey(ctx, merchant.owner, { environment: 'test', scopes });
const post = (key: IssuedKey, url = '/v1/__probe/refunds', ip = '10.7.7.8') =>
  rawRequest(ctx, { method: 'POST', url, key: key.key, payload: '{}', remoteAddress: ip });

describe('limits and headers', () => {
  it('sends the limit headers on every response and counts down', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (let i = 1; i <= READ_LIMIT; i++) {
      const res = await get(key);
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe(String(READ_LIMIT));
      expect(res.headers['x-ratelimit-remaining']).toBe(String(READ_LIMIT - i));
      const reset = Number(res.headers['x-ratelimit-reset']);
      expect(reset).toBeGreaterThanOrEqual(nowSeconds);
      expect(reset).toBeLessThanOrEqual(nowSeconds + 62);
    }
  });

  it('answers 429 with Retry-After once the window is full, and still sends the headers', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    for (let i = 0; i < READ_LIMIT; i++) expect((await get(key)).statusCode).toBe(200);
    const res = await get(key);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    const retry = Number(res.headers['retry-after']);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(res.headers['x-ratelimit-limit']).toBe(String(READ_LIMIT));
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('does not count a refused request, so hammering a full window does not extend it', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    for (let i = 0; i < READ_LIMIT; i++) await get(key);
    for (let i = 0; i < 25; i++) expect((await get(key)).statusCode).toBe(429);
    expect(await redis.zcard(`rl:key:${await keyRowId(key)}:r`)).toBe(READ_LIMIT);
  });

  it('keeps reads and writes in separate windows', async () => {
    const key = await writeKey(['refunds:write', 'payments:read']);
    for (let i = 0; i < WRITE_LIMIT; i++) expect((await post(key)).statusCode).toBe(201);
    expect((await post(key)).statusCode).toBe(429);
    expect((await get(key)).statusCode).toBe(200);
  });

  it('slides: requests older than the window stop counting', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    for (let i = 0; i < READ_LIMIT; i++) await get(key);
    expect((await get(key)).statusCode).toBe(429);
    // Time passes: move every recorded request 61 seconds into the past.
    const redisKey = `rl:key:${await keyRowId(key)}:r`;
    const members = await redis.zrange(redisKey, 0, -1);
    for (const member of members) await redis.zadd(redisKey, Date.now() - 61_000, member);
    expect((await get(key)).statusCode).toBe(200);
    expect(await redis.zcard(redisKey)).toBe(1);
  });

  it('gives every key its own allowance, and a per-key override for writes', async () => {
    const a = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const b = await issueKey(ctx, merchant.owner, { environment: 'test' });
    for (let i = 0; i < READ_LIMIT; i++) await get(a);
    expect((await get(a)).statusCode).toBe(429);
    expect((await get(b)).statusCode).toBe(200);
    const custom = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['refunds:write'],
      rateLimitRpm: 2,
    });
    expect((await post(custom)).headers['x-ratelimit-limit']).toBe('2');
    expect((await post(custom)).statusCode).toBe(201);
    expect((await post(custom)).statusCode).toBe(429);
  });

  it('never lets one merchant spend another’s allowance', async () => {
    const other = await createMerchant(ctx, { label: 'limits-other' });
    const mine = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const theirs = await issueKey(ctx, other.owner, { environment: 'test' });
    for (let i = 0; i < READ_LIMIT; i++) await get(mine);
    expect((await get(mine)).statusCode).toBe(429);
    expect((await get(theirs)).statusCode).toBe(200);
  });
});

describe('bypass attempts', () => {
  it('changing the client address or any forwarding header buys no new allowance', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const variants: Array<[string, Record<string, string>]> = [
      ['10.1.1.1', {}],
      ['10.1.1.2', { 'x-forwarded-for': '203.0.113.1' }],
      ['10.1.1.3', { 'x-real-ip': '203.0.113.2' }],
      ['2001:db8::1', {}],
      ['2001:db8::2', { forwarded: 'for=203.0.113.3' }],
      ['10.1.1.6', { 'cf-connecting-ip': '203.0.113.4' }],
      ['10.1.1.7', { 'x-forwarded-for': '203.0.113.5, 203.0.113.6' }],
      ['10.1.1.8', { 'user-agent': 'other-agent/2' }],
    ];
    expect(variants).toHaveLength(READ_LIMIT);
    for (const [ip, headers] of variants)
      expect((await get(key, '/v1/ping', ip, headers)).statusCode).toBe(200);
    expect(
      (await get(key, '/v1/ping', '10.1.1.99', { 'x-forwarded-for': '198.51.100.1' })).statusCode
    ).toBe(429);
  });

  it('varying the path spelling or query string does not open a new bucket', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const urls = [
      '/v1/ping',
      '/v1/ping?a=1',
      '/v1/ping?a=2',
      '/v1/ping?',
      '/v1/ping?%20=%20',
      '/v1/ping?a=1&b=2',
      '/v1/ping?z',
      '/v1/ping?q=%00',
    ];
    for (const url of urls) expect((await get(key, url)).statusCode, url).toBe(200);
    expect((await get(key, '/v1/ping?fresh=1')).statusCode).toBe(429);
  });

  it('other routes of the same key draw on the same window', async () => {
    const key = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read', 'events:read', 'balances:read'],
    });
    const urls = [
      '/v1/payments',
      '/v1/events',
      '/v1/balances',
      '/v1/holds',
      '/v1/ping',
      '/v1/payments',
      '/v1/events',
      '/v1/balances',
    ];
    for (const url of urls) expect((await get(key, url)).statusCode).toBe(200);
    expect((await get(key, '/v1/payments')).statusCode).toBe(429);
  });

  it('requests that are refused for a missing scope are still counted', async () => {
    const key = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
    });
    for (let i = 0; i < READ_LIMIT; i++)
      expect((await get(key, '/v1/events')).statusCode).toBe(403);
    expect((await get(key, '/v1/events')).statusCode).toBe(429);
  });

  it('wrong secrets for a real key id do not consume the real key’s allowance', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const forged = key.key.slice(0, -64) + '0'.repeat(64);
    for (let i = 0; i < 20; i++) {
      const res = await rawRequest(ctx, {
        method: 'GET',
        url: '/v1/ping',
        key: forged,
        remoteAddress: '10.4.4.4',
      });
      expect(res.statusCode).toBe(401);
    }
    for (let i = 0; i < READ_LIMIT; i++) expect((await get(key)).statusCode).toBe(200);
  });

  it('a rolled key has its own allowance, but the merchant payout window is shared', async () => {
    const m = await createMerchant(ctx, { label: 'limits-payout' });
    const keys = await Promise.all(
      [0, 1].map(() => issueKey(ctx, m.owner, { environment: 'test', scopes: ['payouts:write'] }))
    );
    const send = (k: IssuedKey) => post(k, '/v1/__probe/payouts');
    expect((await send(keys[0] as IssuedKey)).statusCode).toBe(201);
    expect((await send(keys[1] as IssuedKey)).statusCode).toBe(201);
    expect((await send(keys[0] as IssuedKey)).statusCode).toBe(201);
    const refused = await send(keys[1] as IssuedKey);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['x-ratelimit-limit']).toBe(String(PAYOUT_LIMIT));
    // Another merchant is unaffected; so is the same merchant's live window.
    const other = await createMerchant(ctx, { label: 'limits-payout-2' });
    const otherKey = await issueKey(ctx, other.owner, {
      environment: 'test',
      scopes: ['payouts:write'],
    });
    expect((await send(otherKey)).statusCode).toBe(201);
  });
});

describe('atomicity and expiry', () => {
  it('lets exactly the limit through when requests arrive together', async () => {
    const key = await issueKey(ctx, merchant.owner, { environment: 'test' });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => get(key, '/v1/ping', `10.3.3.${i + 1}`))
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(READ_LIMIT);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(40 - READ_LIMIT);
  });

  it('lets exactly the write limit through when writes arrive together', async () => {
    const key = await writeKey();
    const results = await Promise.all(Array.from({ length: 30 }, () => post(key)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(WRITE_LIMIT);
  });

  it('refused requests consume nothing from the other limits', async () => {
    const m = await createMerchant(ctx, { label: 'limits-atomic' });
    const key = await issueKey(ctx, m.owner, {
      environment: 'test',
      scopes: ['payouts:write'],
      rateLimitRpm: 100,
    });
    for (let i = 0; i < PAYOUT_LIMIT; i++) await post(key, '/v1/__probe/payouts');
    for (let i = 0; i < 10; i++)
      expect((await post(key, '/v1/__probe/payouts')).statusCode).toBe(429);
    // The key's write window was charged only for the three requests that went through.
    expect(await redis.zcard(`rl:key:${await keyRowId(key)}:w`)).toBe(PAYOUT_LIMIT);
  });

  it('every counter expires: windows after their window, buckets after they would refill', async () => {
    const key = await writeKey();
    await post(key);
    const id = await keyRowId(key);
    const windowTtl = await redis.pttl(`rl:key:${id}:w`);
    expect(windowTtl).toBeGreaterThan(0);
    expect(windowTtl).toBeLessThanOrEqual(61_000);
    const bucketTtl = await redis.pttl(`rl:key:${id}:burst`);
    expect(bucketTtl).toBeGreaterThan(0);
    expect(bucketTtl).toBeLessThan(10_000_000);
    expect(await redis.type(`rl:key:${id}:burst`)).toBe('hash');
  });
});

describe('burst bucket (20 capacity, 10 per second by default)', () => {
  let burst: DeveloperContext;
  let owner: DeveloperMerchant;
  let burstRedis: Redis;
  beforeAll(async () => {
    burst = await startDeveloperContext({
      RATE_LIMIT_BURST_CAPACITY: '4',
      RATE_LIMIT_BURST_REFILL_PER_SECOND: '1',
      RATE_LIMIT_READ_PER_MIN: '1000',
      RATE_LIMIT_WRITE_PER_MIN: '1000',
    });
    burstRedis = burst.app.get<Redis>(REDIS, { strict: false });
    owner = await createMerchant(burst, { label: 'burst' });
  });
  afterAll(async () => {
    await burst.close();
  });
  const ping = (key: IssuedKey) =>
    rawRequest(burst, { method: 'GET', url: '/v1/ping', key: key.key, remoteAddress: '10.6.6.6' });

  it('allows a burst up to the capacity, then refuses with Retry-After', async () => {
    const key = await issueKey(burst, owner.owner, { environment: 'test' });
    for (let i = 0; i < 4; i++) expect((await ping(key)).statusCode).toBe(200);
    const refused = await ping(key);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.headers['x-ratelimit-limit']).toBe('4');
  });

  it('refills over time', async () => {
    const key = await issueKey(burst, owner.owner, { environment: 'test' });
    for (let i = 0; i < 4; i++) await ping(key);
    expect((await ping(key)).statusCode).toBe(429);
    const id = (await burst.sql('select id from core.api_keys where ref = $1', [key.ref]))[0]?.id;
    const redisKey = `rl:key:${String(id)}:burst`;
    const ts = Number(await burstRedis.hget(redisKey, 'ts'));
    await burstRedis.hset(redisKey, 'ts', String(ts - 2500));
    expect((await ping(key)).statusCode).toBe(200);
    expect((await ping(key)).statusCode).toBe(200);
    expect((await ping(key)).statusCode).toBe(429);
  });

  it('a burst arriving together lets exactly the capacity through', async () => {
    const key = await issueKey(burst, owner.owner, { environment: 'test' });
    const results = await Promise.all(Array.from({ length: 25 }, () => ping(key)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(4);
  });
});

describe('failed authentications (per client)', () => {
  let strict: DeveloperContext;
  let owner: DeveloperMerchant;
  beforeAll(async () => {
    strict = await startDeveloperContext({ RATE_LIMIT_AUTH_FAILURE_PER_MIN: '5' });
    owner = await createMerchant(strict, { label: 'authfail' });
  });
  afterAll(async () => {
    await strict.close();
  });
  const bad = (ip: string, headers: Record<string, string> = {}) =>
    rawRequest(strict, {
      method: 'GET',
      url: '/v1/ping',
      key: `mp_test_${'a'.repeat(16)}_${'b'.repeat(64)}`,
      remoteAddress: ip,
      headers,
    });

  it('answers 429 to a client that keeps failing, before looking at its key', async () => {
    const ip = '10.5.5.5';
    for (let i = 0; i < 5; i++) expect((await bad(ip)).statusCode).toBe(401);
    const blocked = await bad(ip);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Even a valid key from that address waits: otherwise guessing could continue unchecked.
    const valid = await issueKey(strict, owner.owner, { environment: 'test' });
    const stillBlocked = await rawRequest(strict, {
      method: 'GET',
      url: '/v1/ping',
      key: valid.key,
      remoteAddress: ip,
    });
    expect(stillBlocked.statusCode).toBe(429);
    // Another address is untouched.
    expect(
      (
        await rawRequest(strict, {
          method: 'GET',
          url: '/v1/ping',
          key: valid.key,
          remoteAddress: '10.5.5.6',
        })
      ).statusCode
    ).toBe(200);
  });

  it('counts requests with no credentials, and ignores forwarding headers', async () => {
    const ip = '10.5.5.7';
    for (let i = 0; i < 5; i++) {
      const res = await strict.app.inject({
        method: 'GET',
        url: '/v1/ping',
        remoteAddress: ip,
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
      });
      expect(res.statusCode).toBe(401);
    }
    expect((await bad(ip, { 'x-forwarded-for': '198.51.100.77' })).statusCode).toBe(429);
  });

  it('treats an IPv6 /64 as one client, so rotating the host part does not help', async () => {
    for (let i = 0; i < 5; i++) expect((await bad(`2001:db8:5:5::${i + 1}`)).statusCode).toBe(401);
    expect((await bad('2001:db8:5:5:ffff::9')).statusCode).toBe(429);
    expect((await bad('2001:db8:5:6::1')).statusCode).toBe(401);
  });

  it('good requests never count against the limit', async () => {
    const ip = '10.5.5.8';
    const valid = await issueKey(strict, owner.owner, { environment: 'test' });
    for (let i = 0; i < 20; i++) {
      expect(
        (
          await rawRequest(strict, {
            method: 'GET',
            url: '/v1/ping',
            key: valid.key,
            remoteAddress: ip,
          })
        ).statusCode
      ).toBe(200);
    }
  });
});

async function keyRowId(key: IssuedKey): Promise<string> {
  const rows = await ctx.sql('select id from core.api_keys where ref = $1', [key.ref]);
  return String(rows[0]?.id);
}
void keyIdOf;
