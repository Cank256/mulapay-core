/**
 * Root Pino logger (spec section 10).
 *
 * Output shape mirrors the gateway (Pino defaults: numeric `level`, epoch `time`, `msg`)
 * so one log pipeline reads both services. Every line gets `requestId`, `surface` and actor
 * fields from the request context plus `trace_id` and `span_id` from the active span, and
 * passes through key-based redaction before it is written.
 *
 * Request and response bodies are never logged.
 */
import { hostname } from 'node:os';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { SERVICE_NAME, type AppConfig } from '../../config/configuration';
import { requestContext } from '../context/request-context';
import { redactDeep, toLoggableError } from './redaction';

export type { Logger } from 'pino';

/** Fields merged into every log line. */
export function logContextFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  const ctx = requestContext.get();
  if (ctx) {
    fields.requestId = ctx.requestId;
    fields.surface = ctx.surface;
    if (ctx.merchantId) fields.merchantId = ctx.merchantId;
    if (ctx.actorType) fields.actorType = ctx.actorType;
    if (ctx.actorId) fields.actorId = ctx.actorId;
  }
  const span = trace.getActiveSpan()?.spanContext();
  if (span && isSpanContextValid(span)) {
    fields.trace_id = span.traceId;
    fields.span_id = span.spanId;
  }
  return fields;
}

type LoggerConfig = Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV' | 'APP_ROLE'>;

export function buildLoggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: { service: SERVICE_NAME, role: config.APP_ROLE, pid: process.pid, hostname: hostname() },
    mixin: logContextFields,
    formatters: {
      log: (object) => redactDeep(object) as Record<string, unknown>,
    },
    serializers: {
      err: toLoggableError,
      error: toLoggableError,
    },
  };
}

/** pino-pretty is a dev dependency; the production image does not contain it. */
function isPrettyAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates the process root logger. Pretty printing is used only in development and only
 * when no explicit destination is given (tests pass a destination to capture output).
 */
export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options = buildLoggerOptions(config);
  if (destination) return pino(options, destination);
  if (config.NODE_ENV === 'development' && isPrettyAvailable()) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(options);
}
