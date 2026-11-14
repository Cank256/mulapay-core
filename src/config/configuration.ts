/**
 * Loads and validates configuration once per process.
 *
 * The parsed config is the only way the application reads the environment; nothing else
 * touches `process.env`. A failed parse prints the variable names and rules that failed
 * (never the values) and exits with status 1.
 */
import { existsSync } from 'node:fs';
import { envSchema, type Env } from './env.schema';

export type AppConfig = Readonly<Env>;
export type AppRole = Env['APP_ROLE'];

export const SERVICE_NAME = 'mulapay-core';

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Parses an environment map. Throws ConfigValidationError listing every failed rule. */
export function parseConfig(source: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `${path}: ${i.message}`;
    });
    throw new ConfigValidationError(issues);
  }
  return Object.freeze(result.data);
}

/**
 * Loads `.env` from the working directory when present. Variables already set in the
 * environment win. Production images do not ship a `.env` file.
 */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

let cached: AppConfig | undefined;

/** Process-wide config. Exits the process if the environment is invalid. */
export function getConfig(): AppConfig {
  if (cached) return cached;
  try {
    cached = parseConfig(process.env);
    return cached;
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

export function isProduction(config: Pick<AppConfig, 'NODE_ENV'>): boolean {
  return config.NODE_ENV === 'production';
}
