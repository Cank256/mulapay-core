/**
 * Configuration of the migration job, deliberately separate from the application's.
 *
 * `node dist/db/migrate.js` runs SQL as `mulapay_core_rw`. It needs one URL. Validating the whole
 * application schema (`src/config/env.schema.ts`) made the job demand the JWT private key, the data
 * encryption key, the PII pepper and the gateway API key, none of which it uses: a migration job
 * would hold the secrets that protect every encrypted column. Least privilege says it holds only
 * the database URL it needs (Phase 9 finding OPS-1).
 */
import { z } from 'zod';

export class MigrateConfigError extends Error {
  constructor(readonly variables: readonly string[]) {
    super(`Invalid migration configuration: ${variables.join(', ')}`);
    this.name = 'MigrateConfigError';
  }
}

const schema = z.object({
  DATABASE_DIRECT_URL: z.string().refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === 'postgres:' || protocol === 'postgresql:';
    } catch {
      return false;
    }
  }, 'must be a postgres:// URL'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type MigrateConfig = z.output<typeof schema>;

/** Reads only the variables the job needs. Errors name variables, never their values. */
export function parseMigrateConfig(env: Record<string, string | undefined>): MigrateConfig {
  const parsed = schema.safeParse({
    DATABASE_DIRECT_URL: env.DATABASE_DIRECT_URL,
    LOG_LEVEL: env.LOG_LEVEL,
  });
  if (!parsed.success) {
    throw new MigrateConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  return parsed.data;
}
