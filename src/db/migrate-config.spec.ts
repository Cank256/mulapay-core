import { describe, expect, it } from 'vitest';
import { MigrateConfigError, parseMigrateConfig } from './migrate-config';

describe('migration job configuration', () => {
  it('needs only the direct database URL: no application secret is required to run SQL', () => {
    const config = parseMigrateConfig({
      NODE_ENV: 'production',
      DATABASE_DIRECT_URL: 'postgres://mulapay_core_rw:secret@db:5432/mulapay',
    });
    expect(config.DATABASE_DIRECT_URL).toBe('postgres://mulapay_core_rw:secret@db:5432/mulapay');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('accepts a log level and ignores every other variable, so a job may be given the full environment', () => {
    const config = parseMigrateConfig({
      DATABASE_DIRECT_URL: 'postgres://u:p@db/mulapay',
      LOG_LEVEL: 'warn',
      JWT_PRIVATE_KEY: 'x',
      DATA_ENCRYPTION_KEY: 'not-validated-here',
    });
    expect(config.LOG_LEVEL).toBe('warn');
    expect(Object.keys(config).sort()).toEqual(['DATABASE_DIRECT_URL', 'LOG_LEVEL']);
  });

  it('refuses a missing or malformed URL, naming the variable and never its value', () => {
    expect(() => parseMigrateConfig({})).toThrow(MigrateConfigError);
    let message = '';
    try {
      parseMigrateConfig({ DATABASE_DIRECT_URL: 'password=hunter2-not-a-url' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_DIRECT_URL');
    expect(message).not.toContain('hunter2');
  });

  it('refuses a non-Postgres URL', () => {
    expect(() => parseMigrateConfig({ DATABASE_DIRECT_URL: 'mysql://u:p@db/x' })).toThrow(
      MigrateConfigError
    );
  });

  it('refuses an unknown log level', () => {
    expect(() =>
      parseMigrateConfig({ DATABASE_DIRECT_URL: 'postgres://u:p@db/x', LOG_LEVEL: 'shout' })
    ).toThrow(MigrateConfigError);
  });
});
