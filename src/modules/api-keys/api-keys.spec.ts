import { describe, expect, it } from 'vitest';
import { generateApiKey, keyPrefix, parseApiKey } from './api-key-format';
import { isKeyUsable } from './api-keys.service';
import { ipAllowed, isCidrEntry } from './ip-allowlist';

describe('API key format (P5-D9)', () => {
  it('generates sk_{env}_{keyId}_{secret} and stores only the secret hash', () => {
    const generated = generateApiKey('live');
    expect(generated.kind).toBe('secret');
    expect(generated.key).toMatch(/^sk_live_[a-z0-9]{16}_[0-9a-f]{64}$/);
    expect(generated.secretHash).toMatch(/^[0-9a-f]{64}$/);
    const parsed = parseApiKey(generated.key);
    expect(parsed).toMatchObject({
      kind: 'secret',
      environment: 'live',
      keyId: generated.keyId,
      legacy: false,
    });
    const secret = (parsed as { secret: string }).secret;
    expect(generated.secretHash).not.toBe(secret);
    expect(generated.key.endsWith(secret)).toBe(true);
    expect(keyPrefix('secret', 'live', generated.keyId)).toBe(`sk_live_${generated.keyId}`);
  });
  it('generates pk_{env}_{keyId} with no secret part and no hash', () => {
    const generated = generateApiKey('test', 'publishable');
    expect(generated.key).toMatch(/^pk_test_[a-z0-9]{16}$/);
    expect(generated.secretHash).toBeNull();
    expect(parseApiKey(generated.key)).toEqual({
      kind: 'publishable',
      environment: 'test',
      keyId: generated.keyId,
    });
    expect(keyPrefix('publishable', 'test', generated.keyId)).toBe(generated.key);
  });
  it('still parses the retired mp_ form, flagged legacy, and never issues it', () => {
    const { key } = generateApiKey('test');
    const legacy = key.replace('sk_test_', 'mp_test_');
    expect(parseApiKey(legacy)).toMatchObject({ kind: 'secret', legacy: true });
    for (let i = 0; i < 20; i += 1)
      expect(generateApiKey('live').key.startsWith('sk_live_')).toBe(true);
  });
  it('rejects anything else', () => {
    const { key } = generateApiKey('test');
    const publishable = generateApiKey('test', 'publishable').key;
    for (const bad of [
      '',
      'sk_test_x',
      'sk_prod_aaaaaaaaaaaaaaaa_' + '0'.repeat(64),
      key.replace('sk_test', 'sk_prod'),
      key.replace('sk_', 'xx_'),
      `${key}0`,
      key.toUpperCase(),
      `${publishable}_${'0'.repeat(64)}`,
      `${publishable}0`,
      publishable.toUpperCase(),
      key.slice(0, key.lastIndexOf('_')),
    ]) {
      expect(parseApiKey(bad), bad).toBeNull();
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
