/**
 * `npm run db:migrate` (dev, via tsx) and `node dist/db/migrate.js` (production image).
 * Connects with DATABASE_DIRECT_URL, which bypasses PgBouncer.
 */
import { join } from 'node:path';
import { getConfig, loadDotEnv } from '../config/configuration';
import { createLogger } from '../common/logging/logger';
import { toLoggableError } from '../common/logging/redaction';
import { runMigrations } from './migrator';

async function main(): Promise<void> {
  loadDotEnv();
  const config = getConfig();
  const logger = createLogger(config);
  if (!config.DATABASE_DIRECT_URL) {
    logger.fatal('DATABASE_DIRECT_URL is required to run migrations');
    process.exitCode = 1;
    return;
  }
  try {
    await runMigrations({
      connectionString: config.DATABASE_DIRECT_URL,
      migrationsFolder: join(__dirname, 'migrations'),
      logger,
    });
  } catch (error) {
    logger.fatal({ err: toLoggableError(error) }, 'migration failed');
    process.exitCode = 1;
  }
}

void main();
