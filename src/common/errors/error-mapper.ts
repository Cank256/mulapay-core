/**
 * Maps any thrown value to a catalogue error. Pure, so every branch is unit-tested.
 *
 * Invariant: a 5xx result never carries client-visible detail, and a client message always
 * comes from the catalogue, never from an arbitrary exception message.
 */
import { HttpException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { AppError } from './app-error';
import { getErrorDefinition, type ErrorCode } from './catalogue';

export interface ResolvedError {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  /** True for errors that indicate a bug or outage and should be logged at error level. */
  readonly isServerError: boolean;
  /** Seconds the client should wait; sent as `Retry-After` by the exception filter. */
  readonly retryAfterSeconds?: number;
}

const STATUS_TO_CODE: Readonly<Record<number, ErrorCode>> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  503: 'SERVICE_UNAVAILABLE',
};

function codeForStatus(status: number): ErrorCode {
  const mapped = STATUS_TO_CODE[status];
  if (mapped) return mapped;
  return status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST';
}

function fromCode(
  code: ErrorCode,
  message?: string,
  details?: Readonly<Record<string, unknown>>
): ResolvedError {
  const def = getErrorDefinition(code);
  const isServerError = def.httpStatus >= 500;
  return {
    code,
    httpStatus: def.httpStatus,
    message: message ?? def.message,
    details: def.exposeDetails && !isServerError ? details : undefined,
    isServerError,
  };
}

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** Per-field validation list. Zod issues do not include the rejected input value. */
export function zodIssuesToFields(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

/** Fastify framework errors (body parsing, size limits) carry `FST_` codes and a status. */
function fastifyStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  if (typeof code === 'string' && code.startsWith('FST_') && typeof statusCode === 'number') {
    return statusCode;
  }
  return undefined;
}

/** Suggested wait after the database is out of connections or refusing new ones. */
export const OVERLOAD_RETRY_AFTER_SECONDS = 5;
/**
 * PostgreSQL SQLSTATEs that mean "no capacity right now", not "this request is wrong":
 * 53300 too_many_connections, 53400 configuration_limit_exceeded, 57P03 cannot_connect_now.
 */
const OVERLOAD_SQLSTATES: ReadonlySet<string> = new Set(['53300', '53400', '57P03']);
/** Messages `pg` and PgBouncer produce when no connection can be had in time. */
const OVERLOAD_MESSAGES: readonly RegExp[] = [
  /timeout exceeded when trying to connect/i,
  /connection terminated due to connection timeout/i,
  /too many clients already/i,
  /no more connections allowed/i,
  /server conn crashed|pool is (?:full|exhausted)/i,
  // A statement cut off by `statement_timeout` (SQLSTATE 57014) rolled back; under overload it is
  // the same "too slow right now" as a full pool.
  /canceling statement due to statement timeout/i,
];
/**
 * True when `error`, or a cause up to three levels down (drizzle wraps driver errors), says the
 * database could not give this request a connection. Nothing ran, so a retry is safe; the
 * idempotency key covers a retry of a request that did run.
 */
export function isCapacityError(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) return false;
  const { code, message, cause } = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof code === 'string' && OVERLOAD_SQLSTATES.has(code)) return true;
  if (typeof message === 'string' && OVERLOAD_MESSAGES.some((re) => re.test(message))) return true;
  return isCapacityError(cause, depth + 1);
}
export function resolveError(error: unknown): ResolvedError {
  if (error instanceof AppError) {
    return fromCode(error.code, error.message, error.details);
  }
  if (isCapacityError(error)) {
    return { ...fromCode('SERVICE_UNAVAILABLE'), retryAfterSeconds: OVERLOAD_RETRY_AFTER_SECONDS };
  }
  if (error instanceof ZodValidationException) {
    const zodError = error.getZodError();
    const fields = zodError instanceof ZodError ? zodIssuesToFields(zodError) : [];
    return fromCode('VALIDATION_FAILED', undefined, { fields });
  }
  if (error instanceof HttpException) {
    return fromCode(codeForStatus(error.getStatus()));
  }
  const status = fastifyStatus(error);
  if (status !== undefined) {
    return fromCode(codeForStatus(status));
  }
  return fromCode('INTERNAL_ERROR');
}
