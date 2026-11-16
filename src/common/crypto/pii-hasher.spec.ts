import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { PiiHasher } from './pii-hasher';

const KEY = randomBytes(32).toString('base64');

describe('PiiHasher', () => {
  it('gives one digest per value and namespace, and a different one for each', () => {
    const hasher = new PiiHasher({
      PII_HMAC_PEPPER: 'p'.repeat(40),
      DATA_ENCRYPTION_KEY: undefined,
    });
    const a = hasher.digest('blocklist:msisdn', '+256700000001');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hasher.digest('blocklist:msisdn', '+256700000001')).toBe(a);
    expect(hasher.digest('blocklist:msisdn', '+256700000002')).not.toBe(a);
    // The same text in another namespace is a different value.
    expect(hasher.digest('blocklist:account', '+256700000001')).not.toBe(a);
  });

  it('depends on the pepper', () => {
    const one = new PiiHasher({ PII_HMAC_PEPPER: 'a'.repeat(40), DATA_ENCRYPTION_KEY: undefined });
    const two = new PiiHasher({ PII_HMAC_PEPPER: 'b'.repeat(40), DATA_ENCRYPTION_KEY: undefined });
    expect(one.digest('x', 'v')).not.toBe(two.digest('x', 'v'));
  });

  it('derives a key from the data key when there is no pepper, and refuses with neither', () => {
    const derived = new PiiHasher({ PII_HMAC_PEPPER: undefined, DATA_ENCRYPTION_KEY: KEY });
    expect(derived.available).toBe(true);
    expect(derived.digest('x', 'v')).toBe(
      new PiiHasher({ PII_HMAC_PEPPER: undefined, DATA_ENCRYPTION_KEY: KEY }).digest('x', 'v')
    );
    const none = new PiiHasher({ PII_HMAC_PEPPER: undefined, DATA_ENCRYPTION_KEY: undefined });
    expect(none.available).toBe(false);
    expect(() => none.digest('x', 'v')).toThrow(AppError);
  });
});
