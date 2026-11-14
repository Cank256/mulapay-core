/**
 * Shared process plumbing for the three entry points: builds the root logger, labels
 * metrics with the role, and turns startup failures, uncaught exceptions and unhandled
 * rejections into a logged fatal error and exit status 1. A financial process does not
 * keep running in an unknown state.
 */
import type { Logger } from 'pino';
import { createLogger } from '../common/logging/logger';
import { toLoggableError } from '../common/logging/redaction';
import { setMetricsRole } from '../common/telemetry/metrics';
import { getConfig, type AppConfig } from '../config/configuration';

export interface ProcessContext {
  readonly config: AppConfig;
  readonly logger: Logger;
}

export function runProcess(name: string, main: (ctx: ProcessContext) => Promise<void>): void {
  const config = getConfig();
  const logger = createLogger(config);
  setMetricsRole(config.APP_ROLE);

  const fatal = (message: string) => (error: unknown) => {
    logger.fatal({ process: name, err: toLoggableError(error) }, message);
    logger.flush();
    process.exit(1);
  };
  process.on('uncaughtException', fatal('uncaught exception'));
  process.on('unhandledRejection', fatal('unhandled promise rejection'));

  main({ config, logger }).catch(fatal(`${name} failed to start`));
}
