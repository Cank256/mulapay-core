/**
 * The error catalogue (spec section 8.1). Every error a client can receive is listed here
 * with its HTTP status, message template, whether retrying the same request may succeed,
 * and whether its `details` are safe to return.
 *
 * Phase 0 holds only platform-level codes. Business codes (INSUFFICIENT_BALANCE,
 * IDEMPOTENCY_KEY_REUSED, ...) are added by the phase that introduces the behaviour.
 *
 * Message templates use `{name}` placeholders filled from `messageParams`.
 */
export interface ErrorDefinition {
  readonly httpStatus: number;
  readonly message: string;
  /** True when the same request, sent again unchanged later, may succeed. */
  readonly retryable: boolean;
  /** True when `details` are machine-actionable and safe to return to the client. */
  readonly exposeDetails: boolean;
}

export const ERROR_CATALOGUE = {
  VALIDATION_FAILED: {
    httpStatus: 400,
    message: 'The request failed validation',
    retryable: false,
    exposeDetails: true,
  },
  INVALID_REQUEST: {
    httpStatus: 400,
    message: 'The request could not be understood',
    retryable: false,
    exposeDetails: false,
  },
  UNAUTHORIZED: {
    httpStatus: 401,
    message: 'Authentication is required',
    retryable: false,
    exposeDetails: false,
  },
  FORBIDDEN: {
    httpStatus: 403,
    message: 'You do not have access to this resource',
    retryable: false,
    exposeDetails: false,
  },
  NOT_FOUND: {
    httpStatus: 404,
    message: 'The requested resource was not found',
    retryable: false,
    exposeDetails: false,
  },
  PAYLOAD_TOO_LARGE: {
    httpStatus: 413,
    message: 'The request body exceeds the size limit',
    retryable: false,
    exposeDetails: false,
  },
  UNSUPPORTED_MEDIA_TYPE: {
    httpStatus: 415,
    message: 'The request content type is not supported',
    retryable: false,
    exposeDetails: false,
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    message: 'An unexpected error occurred. Please try again later.',
    retryable: true,
    exposeDetails: false,
  },
  SERVICE_UNAVAILABLE: {
    httpStatus: 503,
    message: 'The service is temporarily unavailable. Please try again later.',
    retryable: true,
    exposeDetails: false,
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CATALOGUE;

export const ERROR_DOCS_BASE_URL = 'https://docs.mulapay.com/errors';

export function errorDocUrl(code: ErrorCode): string {
  return `${ERROR_DOCS_BASE_URL}/${code.toLowerCase()}`;
}

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOGUE[code];
}

export function renderMessage(template: string, params?: Readonly<Record<string, string>>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
