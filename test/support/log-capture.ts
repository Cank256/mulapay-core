import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import { createLogger } from '../../src/common/logging/logger';
import type { AppConfig } from '../../src/config/configuration';

export interface CapturedLogs {
  readonly logger: Logger;
  readonly lines: Array<Record<string, unknown>>;
  readonly raw: string[];
}

/** A real root logger (same options as production) writing to memory. */
export function captureLogs(
  config: Pick<AppConfig, 'NODE_ENV' | 'APP_ROLE'>,
  level: AppConfig['LOG_LEVEL'] = 'debug'
): CapturedLogs {
  const lines: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line) continue;
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: createLogger({ ...config, LOG_LEVEL: level }, stream), lines, raw };
}
