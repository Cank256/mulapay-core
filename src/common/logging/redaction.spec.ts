import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  redactDeep,
  redactSecretText,
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

  it('drops SQL and bound parameters from Drizzle query errors, in message and stack', () => {
    const message =
      'Failed query: select * from core.users where email = $1\nparams: ada@example.com';
    const error = new Error(message, {
      cause: Object.assign(new Error('syntax error'), { code: '42601' }),
    });
    const safe = toLoggableError(error);
    const text = JSON.stringify(safe);
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('select *');
    expect(safe.message).toBe('Failed query: [sql and parameters omitted]');
    expect(safe.cause).toMatchObject({ code: '42601', message: 'syntax error' });
  });

  it('handles non-errors and HTTP status fields', () => {
    expect(toLoggableError('boom')).toEqual({ message: 'boom' });
    expect(toLoggableError(Object.assign(new Error('x'), { statusCode: 413 })).status).toBe(413);
  });
});

const HEX64 = 'a1b2c3d4'.repeat(8);
const SECRET_KEYS = [
  `mp_live_abcdefghij012345_${HEX64}`,
  `mp_test_abcdefghij012345_${HEX64}`,
  `sk_live_abcdefghij012345_${HEX64}`,
  `sk_test_abcdefghij012345_${HEX64}`,
  `mpsig_${HEX64}`,
  `whsec_${HEX64}`,
];
const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c3JfMSJ9.c2lnbmF0dXJlLXZhbHVl';
describe('redactSecretText', () => {
  it.each(SECRET_KEYS)('redacts %s inside free text', (secret) => {
    const out = redactSecretText(`call failed for key ${secret}, retrying`);
    expect(out).toBe(`call failed for key ${REDACTED}, retrying`);
  });
  it('redacts bearer credentials, JWTs and PEM private keys', () => {
    expect(redactSecretText('Authorization: Bearer abc123DEF456ghi789')).toBe(
      `Authorization: ${REDACTED}`
    );
    expect(redactSecretText(`token=${JWT}&x=1`)).toBe(`token=${REDACTED}&x=1`);
    const pem = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA\n-----END PRIVATE KEY-----';
    expect(redactSecretText(`key ${pem} end`)).toBe(`key ${REDACTED} end`);
    expect(redactSecretText('-----BEGIN PRIVATE KEY-----\ntruncated')).toBe(REDACTED);
  });
  it('leaves publishable keys, ordinary ids and short look-alikes alone', () => {
    const text = 'pk_live_abcdefghij012345 usr_01HZ merchant mp_refresh sk_test_short whsec_abc';
    expect(redactSecretText(text)).toBe(text);
  });
  it('redacts the same secret twice in one string', () => {
    const secret = SECRET_KEYS[0] as string;
    expect(redactSecretText(`${secret} ${secret}`)).toBe(`${REDACTED} ${REDACTED}`);
  });
});
describe('value redaction through redactDeep and toLoggableError', () => {
  it('scrubs a secret under an innocent key, in arrays and nested objects', () => {
    const secret = SECRET_KEYS[2] as string;
    const out = redactDeep({
      note: `used ${secret}`,
      list: [`x ${JWT}`, 1, null],
      nested: { detail: { text: `Bearer abcdefgh12345678` } },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain('abcdefgh12345678');
    expect(text).toContain(REDACTED);
  });
  it('scrubs a secret in an error message, stack and non-Error value', () => {
    const secret = SECRET_KEYS[4] as string;
    const safe = toLoggableError(new Error(`bad signature ${secret}`));
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(toLoggableError(`raw ${secret}`))).not.toContain(secret);
  });
});
