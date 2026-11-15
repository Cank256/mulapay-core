import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { randomAlphanumeric, randomToken, safeEqual, sha256Hex } from './crypto';
import { FieldEncryption } from './field-encryption';

describe('crypto helpers', () => {
  it('hashes, generates tokens and compares in constant time', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomAlphanumeric(16)).toMatch(/^[a-z0-9]{16}$/);
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'diff')).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
  });
});

describe('FieldEncryption', () => {
  const key = randomBytes(32).toString('base64');
  const enc = new FieldEncryption({ DATA_ENCRYPTION_KEY: key, KMS_KEY_ID: undefined });

  it('round-trips a value bound to its context', () => {
    const ciphertext = enc.encrypt('JBSWY3DPEHPK3PXP', 'users.mfa_secret_enc:u1');
    expect(ciphertext).toMatch(/^v1\.[0-9a-f]{12}\./);
    expect(ciphertext).not.toContain('JBSWY3DPEHPK3PXP');
    expect(enc.decrypt(ciphertext, 'users.mfa_secret_enc:u1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV for every value', () => {
    expect(enc.encrypt('x', 'c')).not.toBe(enc.encrypt('x', 'c'));
  });

  it('refuses another context, a tampered value, another key and bad formats', () => {
    const ciphertext = enc.encrypt('secret', 'users.mfa_secret_enc:u1');
    expect(() => enc.decrypt(ciphertext, 'users.mfa_secret_enc:u2')).toThrow();
    const parts = ciphertext.split('.');
    const body = Buffer.from(parts[4] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 1;
    parts[4] = body.toString('base64url');
    expect(() => enc.decrypt(parts.join('.'), 'users.mfa_secret_enc:u1')).toThrow();
    const other = new FieldEncryption({
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      KMS_KEY_ID: undefined,
    });
    expect(() => other.decrypt(ciphertext, 'users.mfa_secret_enc:u1')).toThrow(
      /unknown format or key/
    );
    expect(() => enc.decrypt('v2.a.b.c.d', 'x')).toThrow(/unknown format/);
    expect(() => enc.decrypt(`${ciphertext}.extra`, 'x')).toThrow(/unknown format/);
  });

  it('is unavailable without a key or with a KMS-wrapped key', () => {
    for (const config of [
      { DATA_ENCRYPTION_KEY: undefined, KMS_KEY_ID: undefined },
      { DATA_ENCRYPTION_KEY: key, KMS_KEY_ID: 'kms-key' },
    ]) {
      const service = new FieldEncryption(config);
      expect(service.available).toBe(false);
      expect(() => service.encrypt('x', 'c')).toThrow(AppError);
      expect(() => service.decrypt('x', 'c')).toThrow(AppError);
    }
  });
});
