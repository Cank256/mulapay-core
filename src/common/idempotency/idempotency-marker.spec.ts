import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { IDEMPOTENCY_TTL_SECONDS, IdempotencyMarker } from './idempotency-marker';
import type { MerchantScope } from '../auth/merchant-scope';
import type { IdempotencyContext } from './idempotency.types';

const scope: MerchantScope = {
  merchantId: 'm-1',
  merchantRef: 'mch_x',
  merchantStatus: 'active',
  environment: 'test',
};
const ctx = (fingerprint: string): IdempotencyContext => ({
  operation: 'payments.create',
  key: 'k1',
  fingerprint,
});

function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn((key: string, value: string, _ex: string, _ttl: number, _nx: string) => {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    eval: vi.fn((_script: string, _n: number, key: string, fingerprint: string) => {
      if (store.get(key) === fingerprint) store.delete(key);
      return Promise.resolve(1);
    }),
  };
  return { redis, store };
}

const logger = { warn: vi.fn() };
const marker = (redis: unknown) =>
  new IdempotencyMarker(redis as Redis, logger as unknown as import('pino').Logger);

describe('IdempotencyMarker', () => {
  it('keys by merchant, environment, operation and key', () => {
    expect(IdempotencyMarker.redisKey(scope, ctx('a'))).toBe('idem:m-1:test:payments.create:k1');
    expect(IdempotencyMarker.redisKey({ ...scope, environment: 'live' }, ctx('a'))).not.toBe(
      IdempotencyMarker.redisKey(scope, ctx('a'))
    );
  });

  it('reserves a free key with the fingerprint, a 24 hour expiry and NX', async () => {
    const { redis, store } = fakeRedis();
    expect(await marker(redis).reserve(scope, ctx('fp'))).toBe('reserved');
    expect(store.get('idem:m-1:test:payments.create:k1')).toBe('fp');
    expect(redis.set).toHaveBeenCalledWith(
      'idem:m-1:test:payments.create:k1',
      'fp',
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
      'NX'
    );
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });

  it('recognises the same fingerprint and a different one', async () => {
    const { redis } = fakeRedis();
    const m = marker(redis);
    await m.reserve(scope, ctx('fp'));
    expect(await m.reserve(scope, ctx('fp'))).toBe('same');
    expect(await m.reserve(scope, ctx('other'))).toBe('different');
  });

  it('treats a key that vanished between the two commands as unavailable, not as a conflict', async () => {
    const redis = {
      set: vi.fn(() => Promise.resolve(null)),
      get: vi.fn(() => Promise.resolve(null)),
    };
    expect(await marker(redis).reserve(scope, ctx('fp'))).toBe('unavailable');
  });

  it('falls back to Postgres when Redis fails', async () => {
    const redis = { set: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) };
    expect(await marker(redis).reserve(scope, ctx('fp'))).toBe('unavailable');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('releases only its own fingerprint', async () => {
    const { redis, store } = fakeRedis();
    const m = marker(redis);
    await m.reserve(scope, ctx('fp'));
    await m.release(scope, ctx('someone-else'));
    expect(store.size).toBe(1);
    await m.release(scope, ctx('fp'));
    expect(store.size).toBe(0);
  });

  it('does not throw when releasing fails', async () => {
    const redis = { eval: vi.fn(() => Promise.reject(new Error('down'))) };
    await expect(marker(redis).release(scope, ctx('fp'))).resolves.toBeUndefined();
  });
});
