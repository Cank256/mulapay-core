import { describe, expect, it } from 'vitest';
import { limitsFor } from './rate-limit.guard';

const CONFIG = {
  RATE_LIMIT_WRITE_PER_MIN: 100,
  RATE_LIMIT_READ_PER_MIN: 600,
  RATE_LIMIT_PAYOUT_PER_MIN: 60,
  RATE_LIMIT_BURST_CAPACITY: 20,
  RATE_LIMIT_BURST_REFILL_PER_SECOND: 10,
};
const KEY = {
  apiKeyId: 'key-1',
  merchant: { id: 'm-1', ref: 'mch_1', status: 'active' as const },
  environment: 'live' as const,
  rateLimitRpm: null,
};

describe('limitsFor (spec 8.5)', () => {
  it('a read is limited by the read window and the burst bucket, in that order', () => {
    const specs = limitsFor(KEY, { write: false, payout: false }, CONFIG);
    expect(specs.map((s) => s.scope)).toEqual(['key_read', 'key_burst']);
    expect(specs[0]).toMatchObject({ kind: 'window', limit: 600, windowSeconds: 60 });
    expect(specs[1]).toMatchObject({ kind: 'bucket', capacity: 20, refillPerSecond: 10 });
  });
  it('a write uses the write window', () => {
    const specs = limitsFor(KEY, { write: true, payout: false }, CONFIG);
    expect(specs.map((s) => s.scope)).toEqual(['key_write', 'key_burst']);
    expect(specs[0]).toMatchObject({ limit: 100 });
  });
  it('a payout also takes the merchant payout window, between the key window and the burst', () => {
    const specs = limitsFor(KEY, { write: true, payout: true }, CONFIG);
    expect(specs.map((s) => s.scope)).toEqual(['key_write', 'merchant_payouts', 'key_burst']);
    expect(specs[1]).toMatchObject({ limit: 60 });
  });
  it('keys the buckets by the API key and merchant, never by anything the client controls', () => {
    const specs = limitsFor(KEY, { write: true, payout: true }, CONFIG);
    expect(specs.map((s) => s.key)).toEqual([
      'rl:key:key-1:w',
      'rl:merchant:m-1:live:payouts',
      'rl:key:key-1:burst',
    ]);
  });
  it('a per-key override replaces the write limit, and reads never fall below it', () => {
    const low = limitsFor({ ...KEY, rateLimitRpm: 7 }, { write: true, payout: false }, CONFIG);
    expect(low[0]).toMatchObject({ limit: 7 });
    expect(
      limitsFor({ ...KEY, rateLimitRpm: 7 }, { write: false, payout: false }, CONFIG)[0]
    ).toMatchObject({ limit: 600 });
    expect(
      limitsFor({ ...KEY, rateLimitRpm: 5000 }, { write: false, payout: false }, CONFIG)[0]
    ).toMatchObject({ limit: 5000 });
  });
  it('separates the payout window of test and live', () => {
    const test = limitsFor({ ...KEY, environment: 'test' }, { write: true, payout: true }, CONFIG);
    expect(test[1]?.key).toBe('rl:merchant:m-1:test:payouts');
  });
});
