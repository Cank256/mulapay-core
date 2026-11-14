import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseConfig } from './configuration';
import { isOrigin, isTrustedProxyEntry } from './env.schema';

const BASE = {
  DATABASE_URL: 'postgres://rw:pw@localhost:5432/mulapay',
  DATABASE_RO_URL: 'postgres://ro:pw@localhost:5432/mulapay',
  REDIS_URL: 'redis://localhost:6379',
};

function issuesFor(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigValidationError) return [...error.issues];
    throw error;
  }
}

function ed25519Pem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function productionEnv(overrides: Record<string, string | undefined> = {}) {
  const keys = ed25519Pem();
  return {
    ...BASE,
    NODE_ENV: 'production',
    REDIS_URL: 'redis://:secret@redis:6379',
    TRUST_PROXY: '10.0.0.0/8',
    GATEWAY_BASE_URL: 'http://gateway:3000',
    GATEWAY_API_KEY: 'gw_live_0123456789abcdef',
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
    JWT_KID: 'k1',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PII_HMAC_PEPPER: 'p'.repeat(32),
    ...overrides,
  };
}

describe('environment schema', () => {
  it('applies the documented defaults', () => {
    const config = parseConfig(BASE);
    expect(config.NODE_ENV).toBe('development');
    expect(config.APP_ROLE).toBe('api');
    expect(config.PORT).toBe(4000);
    expect(config.DB_POOL_MAX).toBe(20);
    expect(config.GATEWAY_EVENT_LAG_SECONDS).toBe(2);
    expect(config.GATEWAY_EVENT_SOURCE).toBe('database');
    expect(config.SANCTIONS_LISTS).toEqual(['UN', 'OFAC', 'EU', 'UK', 'PEP']);
    expect(config.TRUST_PROXY).toEqual([]);
    expect(config.ENABLE_API_DOCS).toBe(false);
  });

  it('treats blank values as unset', () => {
    const config = parseConfig({ ...BASE, PORT: '', DATABASE_REPLICA_URL: '  ', LOG_LEVEL: '' });
    expect(config.PORT).toBe(4000);
    expect(config.DATABASE_REPLICA_URL).toBeUndefined();
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('parses monetary thresholds as bigint minor units', () => {
    const config = parseConfig({ ...BASE, PAYOUT_APPROVAL_THRESHOLD_MINOR: '9007199254740993' });
    expect(config.PAYOUT_APPROVAL_THRESHOLD_MINOR).toBe(9007199254740993n);
    expect(typeof config.REFUND_APPROVAL_THRESHOLD_MINOR).toBe('bigint');
    expect(config.SETTLEMENT_MIN_PAYOUT_MINOR).toBe(10000n);
  });

  it.each(['12.5', '-1', '1e6', 'abc', '9223372036854775808'])(
    'rejects %s as a minor-unit amount',
    (value) => {
      expect(issuesFor({ ...BASE, PAYOUT_APPROVAL_THRESHOLD_MINOR: value })[0]).toMatch(
        /^PAYOUT_APPROVAL_THRESHOLD_MINOR:/
      );
    }
  );

  it('reports every missing required variable without echoing values', () => {
    const issues = issuesFor({ REDIS_URL: 'redis://:topsecret@localhost:6379', PORT: 'x' });
    expect(issues).toEqual(
      expect.arrayContaining([
        'DATABASE_URL: is required',
        'DATABASE_RO_URL: is required',
        expect.stringMatching(/^PORT:/),
      ])
    );
    expect(issues.join('\n')).not.toContain('topsecret');
  });

  it('rejects non-postgres database URLs and non-redis Redis URLs', () => {
    const issues = issuesFor({ ...BASE, DATABASE_URL: 'mysql://x@y/z', REDIS_URL: 'http://r' });
    expect(issues).toContain('DATABASE_URL: must be a postgres:// or postgresql:// URL');
    expect(issues).toContain('REDIS_URL: must be a redis:// or rediss:// URL');
  });

  it('refuses a gateway event lag below the mandatory 2 seconds', () => {
    expect(issuesFor({ ...BASE, GATEWAY_EVENT_LAG_SECONDS: '1' })[0]).toMatch(
      /^GATEWAY_EVENT_LAG_SECONDS:/
    );
  });

  it('enforces cross-field rules', () => {
    expect(issuesFor({ ...BASE, DB_POOL_MIN: '30', DB_POOL_MAX: '10' })).toContain(
      'DB_POOL_MIN: must not exceed DB_POOL_MAX'
    );
    expect(issuesFor({ ...BASE, ENABLE_TELEMETRY: 'true' })).toContain(
      'TELEMETRY_ENDPOINT: is required when ENABLE_TELEMETRY=true'
    );
    expect(issuesFor({ ...BASE, APP_ROLE: 'consumer' })[0]).toMatch(/^DATABASE_DIRECT_URL:/);
  });

  it('requires a 32-byte data encryption key unless KMS wraps it', () => {
    const short = randomBytes(16).toString('base64');
    expect(issuesFor({ ...BASE, DATA_ENCRYPTION_KEY: short })[0]).toMatch(/exactly 32 bytes/);
    expect(issuesFor({ ...BASE, DATA_ENCRYPTION_KEY: short, KMS_KEY_ID: 'kms-1' })).toEqual([]);
  });

  it('accepts a matching Ed25519 key pair with \\n-escaped PEM', () => {
    const keys = ed25519Pem();
    const config = parseConfig({
      ...BASE,
      JWT_PRIVATE_KEY: keys.privateKey.replace(/\n/g, '\\n'),
      JWT_PUBLIC_KEY: keys.publicKey.replace(/\n/g, '\\n'),
      JWT_KID: 'k1',
    });
    expect(config.JWT_PRIVATE_KEY).toContain('\n');
  });

  it('rejects mismatched, non-Ed25519 or incomplete JWT keys', () => {
    const a = ed25519Pem();
    const b = ed25519Pem();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(
      issuesFor({
        ...BASE,
        JWT_PRIVATE_KEY: a.privateKey,
        JWT_PUBLIC_KEY: b.publicKey,
        JWT_KID: 'k',
      })
    ).toContain('JWT_PUBLIC_KEY: does not match JWT_PRIVATE_KEY');
    expect(
      issuesFor({
        ...BASE,
        JWT_PRIVATE_KEY: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        JWT_PUBLIC_KEY: a.publicKey,
        JWT_KID: 'k',
      })
    ).toContain('JWT_PRIVATE_KEY: must be an Ed25519 private key in PEM format');
    expect(issuesFor({ ...BASE, JWT_PRIVATE_KEY: a.privateKey })).toContain(
      'JWT_PRIVATE_KEY: requires JWT_PUBLIC_KEY and JWT_KID'
    );
    expect(issuesFor({ ...BASE, JWT_PREVIOUS_PUBLIC_KEY: 'not a key' })).toContain(
      'JWT_PREVIOUS_PUBLIC_KEY: must be an Ed25519 public key in PEM format'
    );
  });

  it('accepts a complete production configuration', () => {
    expect(issuesFor(productionEnv())).toEqual([]);
  });

  it.each([
    ['TRUST_PROXY', 'TRUST_PROXY: is required in production (comma-separated proxy CIDRs)'],
    ['GATEWAY_API_KEY', 'GATEWAY_API_KEY: is required in production'],
    ['JWT_KID', 'JWT_PRIVATE_KEY: requires JWT_PUBLIC_KEY and JWT_KID'],
    ['DATA_ENCRYPTION_KEY', 'DATA_ENCRYPTION_KEY: is required in production'],
    ['PII_HMAC_PEPPER', 'PII_HMAC_PEPPER: is required in production'],
  ])('refuses production without %s', (key, message) => {
    expect(issuesFor(productionEnv({ [key]: undefined }))).toContain(message);
  });

  it('refuses unauthenticated Redis and API docs in production', () => {
    expect(issuesFor(productionEnv({ REDIS_URL: 'redis://redis:6379' }))).toContain(
      'REDIS_URL: must include a password in production'
    );
    expect(issuesFor(productionEnv({ ENABLE_API_DOCS: 'true' }))[0]).toMatch(/^ENABLE_API_DOCS:/);
  });

  it('refuses wildcard trusted proxies', () => {
    for (const value of ['*', '0.0.0.0/0', '::/0', 'true', '10.0.0.0/33']) {
      expect(issuesFor({ ...BASE, TRUST_PROXY: value })[0]).toMatch(/^TRUST_PROXY\.0:/);
    }
    expect(
      parseConfig({ ...BASE, TRUST_PROXY: '10.0.0.0/8, 192.168.1.10,fd00::/8' }).TRUST_PROXY
    ).toEqual(['10.0.0.0/8', '192.168.1.10', 'fd00::/8']);
  });

  it('refuses wildcard or malformed CORS origins', () => {
    expect(issuesFor({ ...BASE, CORS_DASHBOARD_ORIGINS: '*' })[0]).toMatch(
      /^CORS_DASHBOARD_ORIGINS\.0:/
    );
    expect(issuesFor({ ...BASE, CORS_ADMIN_ORIGINS: 'https://admin.mulapay.com/' })[0]).toMatch(
      /^CORS_ADMIN_ORIGINS\.0:/
    );
  });

  it('rejects malformed optional values', () => {
    const issues = issuesFor({
      ...BASE,
      FCM_CREDENTIALS_JSON: '{not json',
      METRICS_TOKEN: 'short',
      EMAIL_PROVIDER: 'smtp',
      REDIS_TLS: 'yes',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'FCM_CREDENTIALS_JSON: must be valid JSON',
        'METRICS_TOKEN: must be at least 24 characters',
        expect.stringMatching(/^EMAIL_PROVIDER:/),
        expect.stringMatching(/^REDIS_TLS:/),
      ])
    );
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(parseConfig(BASE))).toBe(true);
  });
});

describe('isTrustedProxyEntry', () => {
  it.each(['10.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8'])('accepts %s', (v) => {
    expect(isTrustedProxyEntry(v)).toBe(true);
  });
  it.each(['*', '10.0.0.0/0', 'host.local', '10.0.0.0/8/1', '10.0.0.0/x'])('rejects %s', (v) => {
    expect(isTrustedProxyEntry(v)).toBe(false);
  });
});

describe('isOrigin', () => {
  it('accepts bare origins only', () => {
    expect(isOrigin('https://app.mulapay.com')).toBe(true);
    expect(isOrigin('http://localhost:5173')).toBe(true);
    expect(isOrigin('https://app.mulapay.com/path')).toBe(false);
    expect(isOrigin('ftp://x.com')).toBe(false);
    expect(isOrigin('not a url')).toBe(false);
  });
});
