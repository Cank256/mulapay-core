import { inject } from 'vitest';
import { parseConfig, type AppConfig } from '../../src/config/configuration';

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
    ...overrides,
  });
}
