/**
 * Log redaction (spec section 10).
 *
 * Follows the gateway's approach (provider_gateway/src/utils/redaction.ts): values are
 * redacted by key name, recursively, before a line is written. Keys are split into words
 * (camelCase, snake_case, kebab-case) and matched on whole words, so `cardNumber` and
 * `x-api-key` are redacted while `shipping` and `discarded` are not.
 *
 * Invariant: no value under a sensitive key reaches a log line, at any nesting depth up to
 * MAX_DEPTH. Deeper values are replaced wholesale rather than written unchecked.
 */

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

/**
 * Word sequences that mark a key as sensitive. The spec list is authorization, x-api-key,
 * x-mulapay-signature, cookie, set-cookie, password, secret, token, mfa_secret, phone,
 * email, account_number, pin, card. The extras below cover common spellings of the same
 * data (msisdn is a phone number, cvv is card data).
 */
const SENSITIVE_WORD_SEQUENCES: readonly (readonly string[])[] = [
  ['authorization'],
  ['api', 'key'],
  ['apikey'],
  ['signature'],
  ['cookie'],
  ['password'],
  ['passphrase'],
  ['secret'],
  ['token'],
  ['phone'],
  ['msisdn'],
  ['email'],
  ['account', 'number'],
  ['pin'],
  ['card'],
  ['cvv'],
  ['private', 'key'],
  ['national', 'id'],
];

export function splitKeyWords(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function containsSequence(words: readonly string[], sequence: readonly string[]): boolean {
  for (let i = 0; i + sequence.length <= words.length; i++) {
    if (sequence.every((part, j) => words[i + j] === part)) return true;
  }
  return false;
}

const keyCache = new Map<string, boolean>();

export function isSensitiveKey(key: string): boolean {
  const cached = keyCache.get(key);
  if (cached !== undefined) return cached;
  const words = splitKeyWords(key);
  const sensitive = SENSITIVE_WORD_SEQUENCES.some((seq) => containsSequence(words, seq));
  if (keyCache.size < 10_000) keyCache.set(key, sensitive);
  return sensitive;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a copy of `value` with every sensitive key's value replaced by `[REDACTED]`.
 * Errors, class instances and buffers are not walked; log errors through `toLoggableError`.
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  if (Buffer.isBuffer(value)) return '[Buffer]';

  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((item) => redactDeep(item, depth + 1, seen));
  }
  if (!isPlainObject(value)) return value;

  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactDeep(inner, depth + 1, seen);
  }
  return out;
}

const SECRET_QUERY_PARAMS = /([?&](?:token|api_key|apikey|key|secret|password|signature)=)[^&#]*/gi;

/** Removes secret-looking query parameter values from a URL before it is logged. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(SECRET_QUERY_PARAMS, `$1${REDACTED}`);
}

interface LooseError {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
  status?: unknown;
  constraint?: unknown;
  table?: unknown;
  stack?: unknown;
  cause?: unknown;
}

/**
 * Reduces an error to fields that are safe to log.
 *
 * Driver and HTTP-client errors carry request configuration, headers and row values
 * (Postgres `detail` contains the conflicting key, which may be PII), so only a fixed set
 * of scalar fields is kept. `cause` is followed a few levels.
 */
/**
 * Drizzle query errors carry the SQL and its bound parameter values in the message (and
 * so in the stack): `Failed query: select ... \nparams: a@b.com,<hash>`. Parameters are
 * row values, including emails and token hashes, so the text after the prefix is dropped.
 */
const QUERY_ERROR_PREFIX = 'Failed query:';
const SCRUBBED_QUERY_MESSAGE = 'Failed query: [sql and parameters omitted]';

function scrubQueryText(message: unknown, stack: unknown): { message: unknown; stack: unknown } {
  if (typeof message !== 'string' || !message.startsWith(QUERY_ERROR_PREFIX)) {
    return { message, stack };
  }
  const scrubbedStack =
    typeof stack === 'string' ? stack.split(message).join(SCRUBBED_QUERY_MESSAGE) : stack;
  return { message: SCRUBBED_QUERY_MESSAGE, stack: scrubbedStack };
}

export function toLoggableError(error: unknown, depth = 0): Record<string, unknown> {
  if (error === null || typeof error !== 'object') {
    return { message: String(error) };
  }
  const e = error as LooseError;
  const { message, stack } = scrubQueryText(e.message, e.stack);
  const safe: Record<string, unknown> = { name: e.name, message };
  if (typeof e.code === 'string' || typeof e.code === 'number') safe.code = e.code;
  const status = e.statusCode ?? e.status;
  if (typeof status === 'number') safe.status = status;
  if (typeof e.constraint === 'string') safe.constraint = e.constraint;
  if (typeof e.table === 'string') safe.table = e.table;
  if (typeof stack === 'string') safe.stack = stack;
  if (e.cause !== undefined && depth < 3) safe.cause = toLoggableError(e.cause, depth + 1);
  return safe;
}
