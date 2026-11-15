import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { parseConfig, type AppConfig } from '../../src/config/configuration';

/** One Ed25519 key pair and one data key per test process; never used outside tests. */
const jwtKeys = generateKeyPairSync('ed25519');
export const TEST_JWT = {
  privateKey: jwtKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  publicKey: jwtKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  kid: 'test-key-1',
};
const DATA_ENCRYPTION_KEY = randomBytes(32).toString('base64');

/** Valid configuration pointing at the Testcontainers instances. */
export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  const urls = inject('databaseUrls');
  return parseConfig({
    NODE_ENV: 'test',
    APP_ROLE: 'api',
    LOG_LEVEL: 'silent',
    DATABASE_URL: urls.rw,
    DATABASE_RO_URL: urls.ro,
    DATABASE_DIRECT_URL: urls.rw,
    DB_POOL_MIN: '0',
    DB_POOL_MAX: '5',
    REDIS_URL: inject('redisUrl'),
    JWT_PRIVATE_KEY: TEST_JWT.privateKey,
    JWT_PUBLIC_KEY: TEST_JWT.publicKey,
    JWT_KID: TEST_JWT.kid,
    DATA_ENCRYPTION_KEY,
    ...overrides,
  });
}
