import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from './webhook-signature';

const SECRET = 'whsec_test';
const PAYLOAD = '{"id":"evt_1","type":"payment.succeeded"}';
const NOW = 1_735_689_600;

describe('signWebhook', () => {
  it('is t=<unix>,v1=<hmac-sha256 of "t.payload">', () => {
    const mac = createHmac('sha256', SECRET).update(`${NOW}.${PAYLOAD}`).digest('hex');
    expect(signWebhook([SECRET], NOW, PAYLOAD)).toBe(`t=${NOW},v1=${mac}`);
  });
  it('carries one v1 per secret during a rotation', () => {
    const header = signWebhook(['new', 'old'], NOW, PAYLOAD);
    expect(header.split(',')).toHaveLength(3);
    expect(verifyWebhookSignature(header, PAYLOAD, 'new', NOW)).toEqual({ valid: true });
    expect(verifyWebhookSignature(header, PAYLOAD, 'old', NOW)).toEqual({ valid: true });
  });
});

describe('verifyWebhookSignature', () => {
  const header = signWebhook([SECRET], NOW, PAYLOAD);
  it('accepts a good signature within the tolerance, in either direction', () => {
    expect(verifyWebhookSignature(header, PAYLOAD, SECRET, NOW)).toEqual({ valid: true });
    expect(verifyWebhookSignature(header, PAYLOAD, SECRET, NOW + 300)).toEqual({ valid: true });
    expect(verifyWebhookSignature(header, PAYLOAD, SECRET, NOW - 300)).toEqual({ valid: true });
  });
  it('rejects a captured delivery replayed after the tolerance (replay)', () => {
    expect(verifyWebhookSignature(header, PAYLOAD, SECRET, NOW + 301)).toEqual({
      valid: false,
      reason: 'stale',
    });
    expect(verifyWebhookSignature(header, PAYLOAD, SECRET, NOW - 301)).toEqual({
      valid: false,
      reason: 'stale',
    });
  });
  it('rejects a changed payload, another secret and a changed timestamp', () => {
    expect(verifyWebhookSignature(header, `${PAYLOAD} `, SECRET, NOW)).toMatchObject({
      reason: 'mismatch',
    });
    expect(verifyWebhookSignature(header, PAYLOAD, 'other', NOW)).toMatchObject({
      reason: 'mismatch',
    });
    const forged = header.replace(`t=${NOW}`, `t=${NOW + 5}`);
    expect(verifyWebhookSignature(forged, PAYLOAD, SECRET, NOW)).toMatchObject({
      reason: 'mismatch',
    });
  });
  it.each([
    '',
    'garbage',
    `t=${NOW}`,
    `v1=${'a'.repeat(64)}`,
    `t=abc,v1=${'a'.repeat(64)}`,
    `t=${NOW},v1=short`,
    `t=${NOW},v1=${'A'.repeat(64)}`,
    `t=${NOW},v1=${'a'.repeat(64)}=extra`,
  ])('calls %j malformed', (bad) => {
    expect(verifyWebhookSignature(bad, PAYLOAD, SECRET, NOW)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });
});
