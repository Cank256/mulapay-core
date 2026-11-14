import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  redactDeep,
  redactUrl,
  splitKeyWords,
  toLoggableError,
} from './redaction';

describe('splitKeyWords', () => {
  it.each([
    ['cardNumber', ['card', 'number']],
    ['x-api-key', ['x', 'api', 'key']],
    ['XApiKey', ['x', 'api', 'key']],
    ['account_number', ['account', 'number']],
    ['MFA_SECRET', ['mfa', 'secret']],
  ])('splits %s', (key, words) => {
    expect(splitKeyWords(key)).toEqual(words);
  });
});

describe('isSensitiveKey', () => {
  // The spec list (section 10) plus common spellings of the same data.
  it.each([
    'authorization',
    'x-api-key',
    'apiKey',
    'x-mulapay-signature',
    'cookie',
    'set-cookie',
    'password',
    'secret',
    'webhookSecret',
    'token',
    'refresh_token',
    'mfa_secret',
    'phone',
    'phoneNumber',
    'msisdn',
    'email',
    'supportEmail',
    'account_number',
    'accountNumber',
    'pin',
    'card',
    'cardNumber',
    'privateKey',
  ])('redacts %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['shipping', 'discarded', 'mapping', 'keyId', 'idempotencyKey', 'requestId', 'amount'])(
    'keeps %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    }
  );
});

describe('redactDeep', () => {
  it('redacts sensitive keys at any depth and keeps the shape', () => {
    const input = {
      merchantId: 'm_1',
      customer: { phone: '+256700000000', profile: { email: 'a@b.c' } },
      headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
      items: [{ cardNumber: '4111111111111111', amount: '100' }],
    };
    expect(redactDeep(input)).toEqual({
      merchantId: 'm_1',
      customer: { phone: REDACTED, profile: { email: REDACTED } },
      headers: { authorization: REDACTED, 'content-type': 'application/json' },
      items: [{ cardNumber: REDACTED, amount: '100' }],
    });
    expect(input.customer.phone).toBe('+256700000000');
  });

  it('handles cycles, buffers, depth and non-plain objects', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(redactDeep(cyclic)).toEqual({ a: 1, self: '[Circular]' });
    expect(redactDeep({ b: Buffer.from('x') })).toEqual({ b: '[Buffer]' });

    let deep: Record<string, unknown> = { password: 'x' };
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(redactDeep(deep))).not.toContain('"x"');

    const date = new Date(0);
    expect(redactDeep({ at: date })).toEqual({ at: date });
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep('plain')).toBe('plain');
  });
});

describe('redactUrl', () => {
  it('removes secret query parameter values', () => {
    expect(redactUrl('/cb?token=abc&ref=1')).toBe(`/cb?token=${REDACTED}&ref=1`);
    expect(redactUrl('/x?api_key=k&signature=s')).toBe(
      `/x?api_key=${REDACTED}&signature=${REDACTED}`
    );
    expect(redactUrl('/v1/payments?cursor=abc')).toBe('/v1/payments?cursor=abc');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('toLoggableError', () => {
  it('keeps a fixed set of safe fields and drops driver detail', () => {
    const pgError = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
      detail: 'Key (email)=(someone@example.com) already exists.',
      config: { headers: { authorization: 'Bearer secret' } },
    });
    const safe = toLoggableError(pgError);
    expect(safe).toMatchObject({
      name: 'Error',
      message: 'duplicate key value',
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
    });
    expect(JSON.stringify(safe)).not.toContain('someone@example.com');
    expect(JSON.stringify(safe)).not.toContain('Bearer secret');
  });

  it('follows causes a bounded number of levels', () => {
    let error = new Error('root');
    for (let i = 0; i < 6; i++) error = new Error(`level ${i}`, { cause: error });
    const safe = toLoggableError(error);
    expect(JSON.stringify(safe).match(/"message"/g)).toHaveLength(4);
  });

  it('handles non-errors and HTTP status fields', () => {
    expect(toLoggableError('boom')).toEqual({ message: 'boom' });
    expect(toLoggableError(Object.assign(new Error('x'), { statusCode: 413 })).status).toBe(413);
  });
});
