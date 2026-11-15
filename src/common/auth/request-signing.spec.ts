import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../crypto/crypto';
import {
  computeSignature,
  parseSignatureHeader,
  parseTimestamp,
  signingString,
  verifySignature,
  withinTolerance,
} from './request-signing';

const SECRET = 'mpsig_test_secret';
const BODY = Buffer.from('{"amountMinor":"10000"}');

describe('signing string', () => {
  it('is timestamp.METHOD.path.sha256(rawBody), per the specification', () => {
    expect(signingString('1735689600', 'post', '/v1/payouts?x=1', BODY)).toBe(
      `1735689600.POST./v1/payouts?x=1.${sha256Hex(BODY)}`
    );
  });
  it('hashes an absent body as the empty string', () => {
    expect(signingString('1', 'GET', '/v1/ping', undefined)).toBe(
      `1.GET./v1/ping.${sha256Hex('')}`
    );
  });
});

describe('computeSignature and verifySignature', () => {
  const signature = computeSignature(SECRET, '1735689600', 'POST', '/v1/payouts', BODY);
  const expectedMac = createHmac('sha256', SECRET)
    .update(`1735689600.POST./v1/payouts.${sha256Hex(BODY)}`)
    .digest('hex');

  it('is v1= and the HMAC-SHA256 of the signing string', () => {
    expect(signature).toBe(`v1=${expectedMac}`);
  });
  it('verifies the exact request', () => {
    const presented = parseSignatureHeader(signature) as Buffer;
    expect(verifySignature(presented, SECRET, '1735689600', 'POST', '/v1/payouts', BODY)).toBe(
      true
    );
  });
  it.each([
    ['another secret', 'other', '1735689600', 'POST', '/v1/payouts', BODY],
    ['another timestamp', SECRET, '1735689601', 'POST', '/v1/payouts', BODY],
    ['another method', SECRET, '1735689600', 'PUT', '/v1/payouts', BODY],
    ['another path', SECRET, '1735689600', 'POST', '/v1/payments', BODY],
    ['an added query string', SECRET, '1735689600', 'POST', '/v1/payouts?a=1', BODY],
    ['another body', SECRET, '1735689600', 'POST', '/v1/payouts', Buffer.from('{}')],
    ['no body', SECRET, '1735689600', 'POST', '/v1/payouts', undefined],
  ])('rejects %s', (_label, secret, timestamp, method, path, body) => {
    const presented = parseSignatureHeader(signature) as Buffer;
    expect(verifySignature(presented, secret, timestamp, method, path, body)).toBe(false);
  });
  it('treats the method case-insensitively, as the signing string upper-cases it', () => {
    const presented = parseSignatureHeader(signature) as Buffer;
    expect(verifySignature(presented, SECRET, '1735689600', 'post', '/v1/payouts', BODY)).toBe(
      true
    );
  });
  it('refuses a presented value of the wrong length without comparing', () => {
    expect(verifySignature(Buffer.alloc(31), SECRET, '1', 'GET', '/', undefined)).toBe(false);
  });
});

describe('parseSignatureHeader', () => {
  const mac = 'a'.repeat(64);
  it('accepts only v1= and 64 lowercase hex characters', () => {
    expect(parseSignatureHeader(`v1=${mac}`)?.length).toBe(32);
    for (const bad of [
      mac,
      `v2=${mac}`,
      `v1=${mac.toUpperCase()}`,
      `v1=${mac}0`,
      `v1=${mac.slice(1)}`,
      `v1=${'g'.repeat(64)}`,
      ` v1=${mac}`,
      '',
    ]) {
      expect(parseSignatureHeader(bad), bad).toBeNull();
    }
  });
});

describe('parseTimestamp and withinTolerance', () => {
  it('accepts digits only', () => {
    expect(parseTimestamp('1735689600')).toBe(1735689600);
    for (const bad of ['', '-1', '1.5', '1e9', ' 1', '0x10', '1735689600000000', 'abc']) {
      expect(parseTimestamp(bad), bad).toBeNull();
    }
  });
  it('allows the tolerance in both directions and no more', () => {
    const now = new Date(1_735_689_600_000);
    expect(withinTolerance(1_735_689_600, now, 300)).toBe(true);
    expect(withinTolerance(1_735_689_300, now, 300)).toBe(true);
    expect(withinTolerance(1_735_689_900, now, 300)).toBe(true);
    expect(withinTolerance(1_735_689_299, now, 300)).toBe(false);
    expect(withinTolerance(1_735_689_901, now, 300)).toBe(false);
  });
});
