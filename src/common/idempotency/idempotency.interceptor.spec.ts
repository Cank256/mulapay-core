import { describe, expect, it } from 'vitest';
import { requestFingerprint } from './idempotency.interceptor';

describe('requestFingerprint', () => {
  const body = { amountMinor: '1000', currency: 'UGX' };

  it('is a sha256 hex digest', () => {
    expect(requestFingerprint('POST', '/v1/payments', body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for the same body, method and path, whatever the key order', () => {
    const a = requestFingerprint('POST', '/v1/payments', body);
    expect(
      requestFingerprint('post', '/v1/payments', { currency: 'UGX', amountMinor: '1000' })
    ).toBe(a);
  });

  it('ignores the query string', () => {
    expect(requestFingerprint('POST', '/v1/payments?x=1', body)).toBe(
      requestFingerprint('POST', '/v1/payments', body)
    );
  });

  it('changes with the body, the method and the path', () => {
    const a = requestFingerprint('POST', '/v1/payments', body);
    expect(requestFingerprint('POST', '/v1/payments', { ...body, amountMinor: '1001' })).not.toBe(
      a
    );
    expect(requestFingerprint('PUT', '/v1/payments', body)).not.toBe(a);
    expect(requestFingerprint('POST', '/v1/payment-links', body)).not.toBe(a);
  });

  it('treats a missing body as null', () => {
    expect(requestFingerprint('POST', '/v1/x', undefined)).toBe(
      requestFingerprint('POST', '/v1/x', null)
    );
  });
});
