/**
 * The error catalogue (spec section 8.1). Every error a client can receive is listed here
 * with its HTTP status, message template, whether retrying the same request may succeed,
 * and whether its `details` are safe to return.
 *
 * Phase 0 added the platform-level codes, Phase 1 the identity, merchant and API key
 * codes, and Phase 2 the ledger codes (including INSUFFICIENT_BALANCE). The payment and
 * transaction domain adds the idempotency and payment codes. Later business codes are added
 * by the phase that introduces the behaviour.
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
  // Phase 2: ledger, accounts and balances (spec 5.3, 6.6, 6.7)
  LEDGER_POSTING_INVALID: {
    httpStatus: 422,
    message: 'The ledger posting is invalid: {reason}',
    retryable: false,
    exposeDetails: true,
  },
  LEDGER_ENTRY_UNBALANCED: {
    httpStatus: 422,
    message: 'The ledger entry does not balance: total debits must equal total credits',
    retryable: false,
    exposeDetails: true,
  },
  LEDGER_ACCOUNT_NOT_FOUND: {
    httpStatus: 422,
    message: 'The ledger account does not exist in this environment',
    retryable: false,
    exposeDetails: true,
  },
  LEDGER_ACCOUNT_INACTIVE: {
    httpStatus: 422,
    message: 'The ledger account is inactive',
    retryable: false,
    exposeDetails: true,
  },
  LEDGER_IDEMPOTENCY_CONFLICT: {
    httpStatus: 409,
    message: 'A different ledger posting already used this idempotency key',
    retryable: false,
    exposeDetails: false,
  },
  LEDGER_ENTRY_NOT_REVERSIBLE: {
    httpStatus: 409,
    message: 'The journal entry cannot be reversed: {reason}',
    retryable: false,
    exposeDetails: false,
  },
  // Details (`available`, `requested`, `currency`) are what spec 8.1 shows for this code.
  INSUFFICIENT_BALANCE: {
    httpStatus: 409,
    message: 'The balance is insufficient for this operation',
    retryable: false,
    exposeDetails: true,
  },
  // Phase 2 remainder: holds (spec 6.7)
  HOLD_NOT_ACTIVE: {
    httpStatus: 409,
    message: 'The hold cannot be changed: {reason}',
    retryable: false,
    exposeDetails: true,
  },
  HOLD_CONFLICT: {
    httpStatus: 409,
    message: 'This hold key was already used for a different hold',
    retryable: false,
    exposeDetails: false,
  },
  // Phase 4 (payments and transactions): idempotency (spec 8.2) and payments (spec 6.1)
  IDEMPOTENCY_KEY_REQUIRED: {
    httpStatus: 400,
    message: 'The Idempotency-Key header is required and must be 1 to 255 printable characters',
    retryable: false,
    exposeDetails: false,
  },
  IDEMPOTENCY_KEY_REUSED: {
    httpStatus: 409,
    message: 'This Idempotency-Key was already used with a different request',
    retryable: false,
    exposeDetails: false,
  },
  REQUEST_IN_PROGRESS: {
    httpStatus: 409,
    message: 'A request with this Idempotency-Key is still being processed. Retry shortly.',
    retryable: true,
    exposeDetails: false,
  },
  PAYMENT_INVALID_TRANSITION: {
    httpStatus: 409,
    message: 'The payment cannot move from {from} to {to}',
    retryable: false,
    exposeDetails: true,
  },
  PAYMENT_REQUEST_INVALID: {
    httpStatus: 422,
    message: 'The payment request is not acceptable: {reason}',
    retryable: false,
    exposeDetails: true,
  },
  PAYMENT_LINK_UNAVAILABLE: {
    httpStatus: 409,
    message: 'The payment link cannot be used: {reason}',
    retryable: false,
    exposeDetails: true,
  },
  CHECKOUT_SESSION_UNAVAILABLE: {
    httpStatus: 409,
    message: 'The checkout session cannot be used: {reason}',
    retryable: false,
    exposeDetails: true,
  },
  // Phase 5: developer platform (spec 6.11, 8.5). Signature failures are 401 because the
  // request is not authenticated as coming from the key holder; none reveals which part of
  // the signing string differed.
  RATE_LIMITED: {
    httpStatus: 429,
    message: 'Too many requests. Retry after the number of seconds in Retry-After.',
    retryable: true,
    exposeDetails: false,
  },
  SIGNATURE_REQUIRED: {
    httpStatus: 401,
    message: 'This request must be signed: send X-MulaPay-Timestamp and X-MulaPay-Signature',
    retryable: false,
    exposeDetails: false,
  },
  SIGNATURE_INVALID: {
    httpStatus: 401,
    message: 'The request signature is invalid',
    retryable: false,
    exposeDetails: false,
  },
  SIGNATURE_TIMESTAMP_INVALID: {
    httpStatus: 401,
    message: 'The signature timestamp is missing, malformed or outside the allowed clock skew',
    retryable: false,
    exposeDetails: false,
  },
  SIGNATURE_REPLAYED: {
    httpStatus: 401,
    message: 'This signature was already used. Sign every request again with a fresh timestamp.',
    retryable: false,
    exposeDetails: false,
  },
  SIGNING_SECRET_MISSING: {
    httpStatus: 403,
    message: 'This API key has no signing secret. Roll the key to create one.',
    retryable: false,
    exposeDetails: false,
  },
  WEBHOOK_URL_REJECTED: {
    httpStatus: 422,
    message: 'The webhook URL is not acceptable: {reason}',
    retryable: false,
    exposeDetails: true,
  },
  WEBHOOK_ENDPOINT_LIMIT_REACHED: {
    httpStatus: 409,
    message: 'The maximum number of webhook endpoints for this environment is reached',
    retryable: false,
    exposeDetails: false,
  },
  WEBHOOK_ENDPOINT_NOT_ACTIVE: {
    httpStatus: 409,
    message: 'The webhook endpoint is not active. Enable it before replaying deliveries.',
    retryable: false,
    exposeDetails: false,
  },
  WEBHOOK_DELIVERY_NOT_REPLAYABLE: {
    httpStatus: 409,
    message: 'The webhook delivery is still pending and cannot be replayed yet',
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
