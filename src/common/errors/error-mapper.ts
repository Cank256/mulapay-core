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

export function resolveError(error: unknown): ResolvedError {
  if (error instanceof AppError) {
    return fromCode(error.code, error.message, error.details);
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
