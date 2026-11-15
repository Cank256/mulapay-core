import { describe, expect, it } from 'vitest';
import { generateApiKey, keyPrefix, parseApiKey } from './api-key-format';
import { isKeyUsable } from './api-keys.service';
import { ipAllowed, isCidrEntry } from './ip-allowlist';

describe('API key format', () => {
  it('generates mp_{env}_{keyId}_{secret} and stores only the secret hash', () => {
    const key = generateApiKey('live');
    expect(key.key).toMatch(/^mp_live_[a-z0-9]{16}_[0-9a-f]{64}$/);
    expect(key.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.secretHash).not.toBe(key.secret);
    expect(parseApiKey(key.key)).toEqual({
      environment: 'live',
      keyId: key.keyId,
      secret: key.secret,
    });
    expect(keyPrefix('live', key.keyId)).toBe(`mp_live_${key.keyId}`);
  });

  it('rejects anything else', () => {
    const { key } = generateApiKey('test');
    for (const bad of [
      '',
      'sk_test_x',
      key.replace('mp_test', 'mp_prod'),
      `${key}0`,
      key.toUpperCase(),
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it('is usable until revoked or expired', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    expect(isKeyUsable({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(isKeyUsable({ revokedAt: null, expiresAt: new Date('2025-01-02') }, now)).toBe(true);
    expect(isKeyUsable({ revokedAt: null, expiresAt: now }, now)).toBe(false);
    expect(isKeyUsable({ revokedAt: now, expiresAt: null }, now)).toBe(false);
  });
});

describe('IP allowlist', () => {
  it('validates entries as Postgres cidr does', () => {
    for (const ok of [
      '10.0.0.1',
      '10.0.0.0/8',
      '192.168.1.0/24',
      '2001:db8::/32',
      '::1',
      '2001:db8::1/128',
    ]) {
      expect(isCidrEntry(ok)).toBe(true);
    }
    for (const bad of [
      '10.0.0.1/8',
      '10.0.0.0/0',
      '10.0.0.0/33',
      'nope',
      '10.0.0.0/8/1',
      '2001:db8::1/32',
      '::ffff:1.2.3.4',
      '1.2.3.4/x',
    ]) {
      expect(isCidrEntry(bad)).toBe(false);
    }
  });

  it('matches client IPs against IPs and networks', () => {
    const list = ['10.0.0.0/8', '203.0.113.7', '2001:db8::/32'];
    expect(ipAllowed(list, '10.20.30.40')).toBe(true);
    expect(ipAllowed(list, '203.0.113.7')).toBe(true);
    expect(ipAllowed(list, '203.0.113.8')).toBe(false);
    expect(ipAllowed(list, '2001:db8::5')).toBe(true);
    expect(ipAllowed(list, '2001:db9::5')).toBe(false);
    expect(ipAllowed(list, 'garbage')).toBe(false);
    expect(ipAllowed(null, '1.2.3.4')).toBe(true);
    expect(ipAllowed([], '1.2.3.4')).toBe(true);
  });
});
