/**
 * `npm run db:migrate` (dev, via tsx) and `node dist/db/migrate.js` (production image).
 * Connects with DATABASE_DIRECT_URL, which bypasses PgBouncer.
 *
 * Reads only that URL and LOG_LEVEL (`migrate-config.ts`): the job never holds the application's
 * signing, encryption or provider secrets.
 */
import { join } from 'node:path';
import pino from 'pino';
import { loadDotEnv } from '../config/configuration';
import { toLoggableError } from '../common/logging/redaction';
import { MigrateConfigError, parseMigrateConfig } from './migrate-config';
import { runMigrations } from './migrator';
async function main(): Promise<void> {
  loadDotEnv();
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'mulapay-core', job: 'migrate' },
  });
  try {
    const config = parseMigrateConfig(process.env);
    logger.level = config.LOG_LEVEL;
    await runMigrations({
      connectionString: config.DATABASE_DIRECT_URL,
      migrationsFolder: join(__dirname, 'migrations'),
      logger,
    });
  } catch (error) {
    if (error instanceof MigrateConfigError) {
      // Only variable names: a value in this message could be a credential.
      logger.fatal({ variables: error.variables }, error.message);
    } else {
      logger.fatal({ err: toLoggableError(error) }, 'migration failed');
    }
    process.exitCode = 1;
  }
}
void main();
