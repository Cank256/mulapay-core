/**
 * Adapts Nest's LoggerService to the root Pino logger so framework messages and
 * application messages share one structured stream.
 */
import type { LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';
import { toLoggableError } from './redaction';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /**
   * Nest calls `logger.method(message, ...optionalParams, context)`; for errors the
   * second argument may be a stack string.
   */
  private write(level: Level, message: unknown, params: unknown[]): void {
    const rest = [...params];
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const fields: Record<string, unknown> = {};
    if (context) fields.context = context;

    if (message instanceof Error) {
      fields.err = toLoggableError(message);
      this.logger[level](fields, message.message);
      return;
    }
    const stack = rest.find((p): p is string => typeof p === 'string');
    if (stack && level === 'error') fields.stack = stack;
    if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...(message as Record<string, unknown>) });
      return;
    }
    this.logger[level](fields, String(message));
  }
}
