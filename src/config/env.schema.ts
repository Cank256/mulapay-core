/**
 * Environment schema (spec section 15).
 *
 * Every variable is validated at boot and the process exits on failure rather than
 * starting half-configured. Error messages name the variable and the rule that failed;
 * they never echo the value, because many of these values are secrets.
 *
 * Monetary values (`*_MINOR`) parse to `bigint` minor units, never `number`.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

const INT64_MAX = 9223372036854775807n;

/** `.env.example` uses empty placeholders; treat blank as "not set". */
function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema.optional());
}

/** The schema's error function reports a missing value as "is required". */
function required<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToUndefined, schema);
}

function urlSchema(protocol: RegExp, rule: string) {
  return z.url({
    protocol,
    error: (issue) => (issue.input === undefined ? 'is required' : rule),
  });
}

function withDefault<T extends z.ZodType>(schema: T, fallback: z.input<T>) {
  return z.preprocess((v) => blankToUndefined(v) ?? fallback, schema);
}

function integer(fallback: number, min: number, max: number) {
  return withDefault(z.coerce.number().int().min(min).max(max), fallback);
}

function flag(fallback: boolean) {
  return withDefault(z.enum(['true', 'false']), fallback ? 'true' : 'false').transform(
    (v) => v === 'true'
  );
}

/** Non-negative integer amount in minor units, parsed to bigint. */
function minorAmount(fallback: string) {
  return withDefault(
    z.string().regex(/^(0|[1-9]\d*)$/, 'must be a non-negative integer amount in minor units'),
    fallback
  )
    .transform((v) => BigInt(v))
    .refine((v) => v <= INT64_MAX, 'exceeds the bigint range');
}

function csv<T extends z.ZodType>(item: T) {
  return z.preprocess((v) => {
    const value = blankToUndefined(v);
    if (value === undefined) return [];
    if (typeof value !== 'string') return value;
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, z.array(item));
}

const postgresUrl = urlSchema(/^postgres(ql)?$/, 'must be a postgres:// or postgresql:// URL');
const redisUrl = urlSchema(/^rediss?$/, 'must be a redis:// or rediss:// URL');
const httpUrl = urlSchema(/^https?$/, 'must be an http:// or https:// URL');

/** A single IP or a CIDR range. Wildcards (`*`, `/0`) are rejected. */
export function isTrustedProxyEntry(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || address === undefined) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  const maxBits = family === 4 ? 32 : 128;
  return bits >= 1 && bits <= maxBits;
}

const trustedProxy = z
  .string()
  .refine(
    isTrustedProxyEntry,
    'entries must be IP addresses or CIDR ranges; wildcards are refused'
  );

/** A browser origin such as `https://dashboard.mulapay.com`: scheme, host, optional port. */
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

const origin = z.string().refine(isOrigin, 'entries must be origins like https://app.example.com');

/** PEM values arrive on one line in most secret stores, with literal "\n" sequences. */
const pem = optional(z.string()).transform((v) => v?.replace(/\\n/g, '\n'));

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const envSchema = z
  .object({
    // Process
    NODE_ENV: withDefault(z.enum(['development', 'test', 'production']), 'development'),
    APP_ROLE: withDefault(z.enum(['api', 'worker', 'consumer']), 'api'),
    PORT: integer(4000, 1, 65535),
    HOST: withDefault(z.string().min(1), '0.0.0.0'),
    TRUST_PROXY: csv(trustedProxy),

    // Database
    DATABASE_URL: required(postgresUrl),
    DATABASE_RO_URL: required(postgresUrl),
    DATABASE_REPLICA_URL: optional(postgresUrl),
    DATABASE_DIRECT_URL: optional(postgresUrl),
    DB_POOL_MIN: integer(2, 0, 200),
    DB_POOL_MAX: integer(20, 1, 200),
    DB_STATEMENT_TIMEOUT_MS: integer(15000, 100, 600000),
    DB_IDLE_TX_TIMEOUT_MS: integer(10000, 100, 600000),

    // Redis
    REDIS_URL: required(redisUrl),
    REDIS_TLS: flag(false),

    // Gateway
    GATEWAY_BASE_URL: optional(httpUrl),
    GATEWAY_API_KEY: optional(z.string().min(16, 'must be at least 16 characters')),
    GATEWAY_API_KEY_HEADER: withDefault(
      z.string().regex(/^[A-Za-z0-9-]+$/, 'must be an HTTP header name'),
      'X-API-Key'
    ),
    GATEWAY_TENANT_ID: withDefault(z.string().min(1), 'core'),
    GATEWAY_TIMEOUT_MS: integer(30000, 1000, 120000),
    GATEWAY_MAX_RETRIES: integer(2, 0, 10),
    GATEWAY_CIRCUIT_FAILURE_THRESHOLD: integer(5, 1, 1000),
    GATEWAY_CIRCUIT_RESET_MS: integer(15000, 1000, 600000),
    GATEWAY_EVENT_SOURCE: withDefault(z.enum(['database', 'http']), 'database'),
    GATEWAY_EVENT_BATCH_SIZE: integer(500, 1, 5000),
    // Spec 3.6: the 2-second lag is mandatory. Lower values risk skipping events.
    GATEWAY_EVENT_LAG_SECONDS: integer(2, 2, 60),
    GATEWAY_EVENT_POLL_MS: integer(500, 50, 60000),
    CONSUMER_LAG_ALERT_SECONDS: integer(60, 1, 86400),

    // Auth
    JWT_PRIVATE_KEY: pem,
    JWT_PUBLIC_KEY: pem,
    JWT_PREVIOUS_PUBLIC_KEY: pem,
    JWT_KID: optional(z.string().min(1)),
    ACCESS_TOKEN_TTL: integer(600, 60, 3600),
    REFRESH_TOKEN_TTL: integer(2592000, 3600, 31536000),
    STEP_UP_WINDOW_SECONDS: integer(300, 30, 3600),
    MFA_ISSUER: withDefault(z.string().min(1), 'MulaPay'),
    SIGNATURE_TOLERANCE_SECONDS: integer(300, 30, 900),

    // Encryption
    KMS_KEY_ID: optional(z.string().min(1)),
    DATA_ENCRYPTION_KEY: optional(z.string().regex(BASE64, 'must be base64')),
    PII_HMAC_PEPPER: optional(z.string().min(32, 'must be at least 32 characters')),

    // Rate limits
    RATE_LIMIT_WRITE_PER_MIN: integer(100, 1, 1_000_000),
    RATE_LIMIT_READ_PER_MIN: integer(600, 1, 1_000_000),
    RATE_LIMIT_PAYOUT_PER_MIN: integer(60, 1, 1_000_000),

    // Business policy (values only; the rules that use them arrive with their modules)
    DEFAULT_CURRENCY: withDefault(
      z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code'),
      'UGX'
    ),
    PAYMENT_EXPIRY_MINUTES: integer(15, 1, 10080),
    HOLD_DEFAULT_EXPIRY_MINUTES: integer(60, 1, 43200),
    PAYOUT_APPROVAL_THRESHOLD_MINOR: minorAmount('5000000'),
    REFUND_APPROVAL_THRESHOLD_MINOR: minorAmount('5000000'),
    SETTLEMENT_DEFAULT_DELAY_DAYS: integer(1, 0, 90),
    SETTLEMENT_MIN_PAYOUT_MINOR: minorAmount('10000'),
    ROLLING_RESERVE_BPS: integer(0, 0, 10000),
    RECON_STALE_MINUTES: integer(10, 1, 1440),
    RECON_GAP_INTERVAL_SECONDS: integer(300, 30, 86400),
    SUSPENSE_ALERT_HOURS: integer(1, 1, 168),

    // Storage
    S3_ENDPOINT: optional(httpUrl),
    S3_REGION: optional(z.string().min(1)),
    S3_BUCKET_DOCUMENTS: optional(z.string().min(3)),
    S3_BUCKET_REPORTS: optional(z.string().min(3)),
    S3_ACCESS_KEY_ID: optional(z.string().min(1)),
    S3_SECRET_ACCESS_KEY: optional(z.string().min(1)),
    PRESIGN_UPLOAD_TTL_SECONDS: integer(900, 60, 3600),
    PRESIGN_DOWNLOAD_TTL_SECONDS: integer(900, 60, 3600),

    // Notifications
    EMAIL_PROVIDER: optional(z.enum(['ses', 'postmark', 'resend'])),
    EMAIL_API_KEY: optional(z.string().min(1)),
    EMAIL_FROM: optional(z.string().min(3)),
    SMS_PROVIDER: optional(z.enum(['africastalking', 'twilio'])),
    SMS_API_KEY: optional(z.string().min(1)),
    SMS_SENDER_ID: optional(z.string().min(1)),
    FCM_PROJECT_ID: optional(z.string().min(1)),
    FCM_CREDENTIALS_JSON: optional(
      z.string().refine((v) => {
        try {
          JSON.parse(v);
          return true;
        } catch {
          return false;
        }
      }, 'must be valid JSON')
    ),

    // Compliance
    SANCTIONS_PROVIDER: optional(z.enum(['opensanctions', 'complyadvantage'])),
    SANCTIONS_API_KEY: optional(z.string().min(1)),
    SANCTIONS_LISTS: z.preprocess(
      (v) => blankToUndefined(v) ?? 'UN,OFAC,EU,UK,PEP',
      csv(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'entries must be upper-case list codes'))
    ),

    // CORS
    CORS_DASHBOARD_ORIGINS: csv(origin),
    CORS_ADMIN_ORIGINS: csv(origin),

    // Observability
    LOG_LEVEL: withDefault(
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
      'info'
    ),
    ENABLE_TELEMETRY: flag(false),
    TELEMETRY_ENDPOINT: optional(httpUrl),
    TELEMETRY_SAMPLE_RATIO: withDefault(z.coerce.number().min(0).max(1), 1),
    METRICS_TOKEN: optional(z.string().min(24, 'must be at least 24 characters')),
    ENABLE_API_DOCS: flag(false),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const isProduction = env.NODE_ENV === 'production';

    if (env.DB_POOL_MIN > env.DB_POOL_MAX) {
      issue('DB_POOL_MIN', 'must not exceed DB_POOL_MAX');
    }
    if (env.ENABLE_TELEMETRY && !env.TELEMETRY_ENDPOINT) {
      issue('TELEMETRY_ENDPOINT', 'is required when ENABLE_TELEMETRY=true');
    }
    if (env.APP_ROLE === 'consumer' && !env.DATABASE_DIRECT_URL) {
      issue('DATABASE_DIRECT_URL', 'is required for APP_ROLE=consumer (singleton advisory lock)');
    }

    validateEncryptionKey(env.DATA_ENCRYPTION_KEY, env.KMS_KEY_ID, issue);
    validateJwtKeys(env, issue);

    if (isProduction) {
      if (env.TRUST_PROXY.length === 0) {
        issue('TRUST_PROXY', 'is required in production (comma-separated proxy CIDRs)');
      }
      if (!redisUrlHasPassword(env.REDIS_URL)) {
        issue('REDIS_URL', 'must include a password in production');
      }
      if (env.ENABLE_API_DOCS) {
        issue(
          'ENABLE_API_DOCS',
          'must be false in production until authenticated docs exist (spec section 7.4)'
        );
      }
      const productionSecrets = [
        'GATEWAY_BASE_URL',
        'GATEWAY_API_KEY',
        'JWT_PRIVATE_KEY',
        'JWT_PUBLIC_KEY',
        'JWT_KID',
        'DATA_ENCRYPTION_KEY',
        'PII_HMAC_PEPPER',
      ] as const;
      for (const key of productionSecrets) {
        if (env[key] === undefined) issue(key, 'is required in production');
      }
    }
  });

export type Env = z.output<typeof envSchema>;

type IssueFn = (path: string, message: string) => void;

function redisUrlHasPassword(url: string): boolean {
  try {
    return new URL(url).password.length > 0;
  } catch {
    return false;
  }
}

function validateEncryptionKey(
  key: string | undefined,
  kmsKeyId: string | undefined,
  issue: IssueFn
) {
  if (key === undefined) return;
  // With KMS the value is a wrapped DEK whose length depends on the KMS; without KMS it
  // is the raw AES-256 key and must be exactly 32 bytes.
  if (kmsKeyId === undefined && Buffer.from(key, 'base64').length !== 32) {
    issue('DATA_ENCRYPTION_KEY', 'must decode to exactly 32 bytes when KMS_KEY_ID is not set');
  }
}

function parseKey(kind: 'private' | 'public', pemValue: string): KeyObject | undefined {
  try {
    return kind === 'private' ? createPrivateKey(pemValue) : createPublicKey(pemValue);
  } catch {
    return undefined;
  }
}

function validateJwtKeys(
  env: Pick<Env, 'JWT_PRIVATE_KEY' | 'JWT_PUBLIC_KEY' | 'JWT_PREVIOUS_PUBLIC_KEY' | 'JWT_KID'>,
  issue: IssueFn
) {
  const privateKey = env.JWT_PRIVATE_KEY ? parseKey('private', env.JWT_PRIVATE_KEY) : undefined;
  const publicKey = env.JWT_PUBLIC_KEY ? parseKey('public', env.JWT_PUBLIC_KEY) : undefined;

  if (env.JWT_PRIVATE_KEY && privateKey?.asymmetricKeyType !== 'ed25519') {
    issue('JWT_PRIVATE_KEY', 'must be an Ed25519 private key in PEM format');
  }
  if (env.JWT_PUBLIC_KEY && publicKey?.asymmetricKeyType !== 'ed25519') {
    issue('JWT_PUBLIC_KEY', 'must be an Ed25519 public key in PEM format');
  }
  if (env.JWT_PREVIOUS_PUBLIC_KEY) {
    const previous = parseKey('public', env.JWT_PREVIOUS_PUBLIC_KEY);
    if (previous?.asymmetricKeyType !== 'ed25519') {
      issue('JWT_PREVIOUS_PUBLIC_KEY', 'must be an Ed25519 public key in PEM format');
    }
  }
  if (env.JWT_PRIVATE_KEY && (!env.JWT_PUBLIC_KEY || !env.JWT_KID)) {
    issue('JWT_PRIVATE_KEY', 'requires JWT_PUBLIC_KEY and JWT_KID');
  }
  if (privateKey?.asymmetricKeyType === 'ed25519' && publicKey?.asymmetricKeyType === 'ed25519') {
    const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    const given = publicKey.export({ format: 'der', type: 'spki' });
    if (!derived.equals(given)) {
      issue('JWT_PUBLIC_KEY', 'does not match JWT_PRIVATE_KEY');
    }
  }
}
