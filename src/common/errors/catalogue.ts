/**
 * The error catalogue (spec section 8.1). Every error a client can receive is listed here
 * with its HTTP status, message template, whether retrying the same request may succeed,
 * and whether its `details` are safe to return.
 *
 * Phase 0 added the platform-level codes and Phase 1 the identity, merchant and API key
 * codes. Later business codes (INSUFFICIENT_BALANCE, IDEMPOTENCY_KEY_REUSED, ...) are
 * added by the phase that introduces the behaviour.
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
  INVALID_CURSOR: {
    httpStatus: 400,
    message: 'The pagination cursor is invalid or does not match the filters',
    retryable: false,
    exposeDetails: false,
  },

  // Phase 1: authentication (spec section 8.3)
  INVALID_CREDENTIALS: {
    httpStatus: 401,
    message: 'The email or password is incorrect',
    retryable: false,
    exposeDetails: false,
  },
  TOO_MANY_LOGIN_ATTEMPTS: {
    httpStatus: 429,
    message: 'Too many failed attempts. Try again later.',
    retryable: true,
    exposeDetails: false,
  },
  MFA_CHALLENGE_INVALID: {
    httpStatus: 401,
    message: 'The MFA challenge is invalid or has expired. Log in again.',
    retryable: false,
    exposeDetails: false,
  },
  INVALID_MFA_CODE: {
    httpStatus: 401,
    message: 'The authentication code is incorrect',
    retryable: false,
    exposeDetails: false,
  },
  MFA_ENROLLMENT_REQUIRED: {
    httpStatus: 403,
    message: 'Multi-factor authentication must be enrolled for this account',
    retryable: false,
    exposeDetails: false,
  },
  MFA_ALREADY_ENABLED: {
    httpStatus: 409,
    message: 'Multi-factor authentication is already enabled',
    retryable: false,
    exposeDetails: false,
  },
  MFA_NOT_ENABLED: {
    httpStatus: 409,
    message: 'Multi-factor authentication is not enabled',
    retryable: false,
    exposeDetails: false,
  },
  MFA_ENROLLMENT_NOT_STARTED: {
    httpStatus: 409,
    message: 'Start MFA enrollment before confirming it',
    retryable: false,
    exposeDetails: false,
  },
  STEP_UP_REQUIRED: {
    httpStatus: 403,
    message: 'Re-authenticate to perform this action',
    retryable: false,
    exposeDetails: false,
  },
  REFRESH_TOKEN_INVALID: {
    httpStatus: 401,
    message: 'The session has expired. Log in again.',
    retryable: false,
    exposeDetails: false,
  },
  CSRF_TOKEN_INVALID: {
    httpStatus: 403,
    message: 'The CSRF token is missing or invalid',
    retryable: false,
    exposeDetails: false,
  },
  EMAIL_ALREADY_REGISTERED: {
    httpStatus: 409,
    message: 'An account with this email already exists',
    retryable: false,
    exposeDetails: false,
  },

  // Phase 1: merchants and team (spec section 6.10)
  MERCHANT_INVALID_TRANSITION: {
    httpStatus: 409,
    message: 'The merchant cannot move from {from} to {to}',
    retryable: false,
    exposeDetails: true,
  },
  MERCHANT_CLOSED: {
    httpStatus: 403,
    message: 'The merchant account is closed. Only reads are allowed.',
    retryable: false,
    exposeDetails: false,
  },
  MERCHANT_NOT_ACTIVE: {
    httpStatus: 409,
    message: 'The merchant must be active for this action',
    retryable: false,
    exposeDetails: false,
  },
  MERCHANT_BALANCE_NOT_ZERO: {
    httpStatus: 409,
    message: 'The merchant has a non-zero balance and cannot be closed',
    retryable: false,
    exposeDetails: false,
  },
  INVITATION_INVALID: {
    httpStatus: 400,
    message: 'The invitation is invalid, expired or already used',
    retryable: false,
    exposeDetails: false,
  },
  INVITATION_ALREADY_PENDING: {
    httpStatus: 409,
    message: 'An invitation for this email is already pending',
    retryable: false,
    exposeDetails: false,
  },
  ALREADY_A_MEMBER: {
    httpStatus: 409,
    message: 'This user is already a member of the merchant',
    retryable: false,
    exposeDetails: false,
  },
  OWNER_PROTECTED: {
    httpStatus: 409,
    message: 'Only the owner can change ownership, and the owner cannot be removed',
    retryable: false,
    exposeDetails: false,
  },

  // Phase 1: roles and API keys
  ROLE_UPDATE_REJECTED: {
    httpStatus: 409,
    message: 'The role change was rejected: {reason}',
    retryable: false,
    exposeDetails: false,
  },
  API_KEY_REVOKED: {
    httpStatus: 409,
    message: 'The API key is already revoked or expired',
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
