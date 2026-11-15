/**
 * Developer platform tables (spec 5.2, 6.11, 8.8; migration 0005): merchant events, the
 * outbox, webhook endpoints and deliveries, and API request logs.
 *
 * Partitioned by month on `created_at` (spec 5.1): `webhook_deliveries` and
 * `api_request_logs`. Partitioning is a hand edit of the generated migration (drizzle-kit
 * cannot express it; see docs/DATABASE.md), so every query on those two tables carries a
 * `created_at` bound. Their public refs embed the creation time (a ULID), so a lookup by ref
 * is a single-partition read.
 *
 * Secrets: `webhook_endpoints.secret_enc` and `previous_secret_enc` are AES-256-GCM
 * ciphertexts (spec 11); the clear secret is shown once and never stored.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { apiKeys } from './api-keys';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { merchants } from './merchants';

export const merchantEvents = core.table(
  'merchant_events',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    type: text('type').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    /** `{ object: ... }`: the resource as the API shows it when the event happened. */
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('merchant_events_ref_key').on(t.ref),
    index('merchant_events_merchant_created_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    check('merchant_events_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('merchant_events_type_check', sql`${t.type} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check('merchant_events_ref_format_check', sql`${t.ref} ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$'`),
  ]
);

export const outbox = core.table(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    /** Identifiers only (spec 8.9): the handler reads the data it needs. */
    payload: jsonb('payload').notNull(),
    /** Makes an enqueue idempotent: the same business fact is one outbox row. */
    dedupeKey: text('dedupe_key').notNull(),
    availableAt: timestamptz('available_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lockedAt: timestamptz('locked_at'),
    lockedBy: text('locked_by'),
    publishedAt: timestamptz('published_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('outbox_dedupe_key_key').on(t.dedupeKey),
    index('outbox_available_idx')
      .on(t.availableAt)
      .where(sql`${t.publishedAt} is null`),
    check('outbox_attempts_check', sql`${t.attempts} >= 0`),
    check('outbox_event_type_check', sql`${t.eventType} ~ '^[a-z_]+(\\.[a-z_]+)+$'`),
    check('outbox_published_check', sql`${t.publishedAt} is null or ${t.lockedAt} is not null`),
  ]
);

export const webhookEndpoints = core.table(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    /** Event types, or `*` for every type. */
    enabledEvents: text('enabled_events').array().notNull(),
    secretEnc: text('secret_enc').notNull(),
    /** The secret before the last rotation: still signs deliveries until it expires. */
    previousSecretEnc: text('previous_secret_enc'),
    previousSecretExpiresAt: timestamptz('previous_secret_expires_at'),
    status: text('status').notNull().default('active'),
    failureCount: integer('failure_count').notNull().default(0),
    lastSuccessAt: timestamptz('last_success_at'),
    lastFailureAt: timestamptz('last_failure_at'),
    disabledAt: timestamptz('disabled_at'),
    /** Soft delete: the delivery history keeps pointing at the endpoint. */
    deletedAt: timestamptz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('webhook_endpoints_ref_key').on(t.ref),
    index('webhook_endpoints_merchant_idx')
      .on(t.merchantId, t.environment, t.createdAt.desc())
      .where(sql`${t.deletedAt} is null`),
    check('webhook_endpoints_environment_check', sql`${t.environment} in ('test', 'live')`),
    check(
      'webhook_endpoints_status_check',
      sql`${t.status} in ('active', 'disabled', 'auto_disabled')`
    ),
    check('webhook_endpoints_url_check', sql`char_length(${t.url}) between 10 and 2048`),
    check('webhook_endpoints_events_check', sql`cardinality(${t.enabledEvents}) > 0`),
    check('webhook_endpoints_failure_count_check', sql`${t.failureCount} >= 0`),
    check(
      'webhook_endpoints_previous_secret_check',
      sql`(${t.previousSecretEnc} is null) = (${t.previousSecretExpiresAt} is null)`
    ),
    check(
      'webhook_endpoints_disabled_check',
      sql`(${t.status} = 'active') = (${t.disabledAt} is null)`
    ),
  ]
);

/**
 * One row per (endpoint, event): the delivery and the state of its attempts (spec 5.2).
 * `pending` awaits an attempt (the first or a retry), `succeeded` got a 2xx, `exhausted`
 * used the whole retry schedule, and `failed` stopped early because the endpoint was
 * disabled or deleted; a failed or exhausted delivery can be replayed.
 */
export const webhookDeliveries = core.table(
  'webhook_deliveries',
  {
    id: uuid('id').notNull(),
    ref: text('ref').notNull(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => merchantEvents.id),
    /** Copied from the event so a replay by type needs no join. */
    eventType: text('event_type').notNull(),
    /** `{endpoint}:{event}:original`, or `...:replay:{id}`: a repeated fan-out adds no row. */
    dedupeKey: text('dedupe_key').notNull(),
    replayOfRef: text('replay_of_ref'),
    attempt: smallint('attempt').notNull().default(0),
    status: text('status').notNull().default('pending'),
    httpStatus: smallint('http_status'),
    responseMs: integer('response_ms'),
    responseBodyExcerpt: text('response_body_excerpt'),
    error: text('error'),
    nextAttemptAt: timestamptz('next_attempt_at'),
    lastAttemptAt: timestamptz('last_attempt_at'),
    /** A short lease so two workers holding the same job do not both send. */
    lockedUntil: timestamptz('locked_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    uniqueIndex('webhook_deliveries_ref_key').on(t.ref, t.createdAt),
    uniqueIndex('webhook_deliveries_dedupe_key').on(t.dedupeKey, t.createdAt),
    index('webhook_deliveries_merchant_created_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    index('webhook_deliveries_endpoint_created_idx').on(t.endpointId, t.createdAt.desc()),
    index('webhook_deliveries_pending_idx')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    check('webhook_deliveries_environment_check', sql`${t.environment} in ('test', 'live')`),
    check(
      'webhook_deliveries_status_check',
      sql`${t.status} in ('pending', 'succeeded', 'failed', 'exhausted')`
    ),
    check('webhook_deliveries_attempt_check', sql`${t.attempt} between 0 and 7`),
    check(
      'webhook_deliveries_pending_check',
      sql`(${t.status} = 'pending') = (${t.nextAttemptAt} is not null)`
    ),
    check(
      'webhook_deliveries_excerpt_check',
      sql`${t.responseBodyExcerpt} is null or char_length(${t.responseBodyExcerpt}) <= 1024`
    ),
  ]
);

/** One row per public API call made with a key (spec 6.11). Never stores a body. */
export const apiRequestLogs = core.table(
  'api_request_logs',
  {
    id: uuid('id').notNull(),
    ref: text('ref').notNull(),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id),
    environment: text('environment').notNull(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id),
    method: text('method').notNull(),
    /** The path as requested, without the query string. */
    path: text('path').notNull(),
    /** The route template (`/v1/payments/:ref`). */
    route: text('route').notNull(),
    statusCode: smallint('status_code').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    requestId: text('request_id').notNull(),
    idempotencyKey: text('idempotency_key'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    uniqueIndex('api_request_logs_ref_key').on(t.ref, t.createdAt),
    index('api_request_logs_merchant_created_idx').on(
      t.merchantId,
      t.environment,
      t.createdAt.desc(),
      t.ref.desc()
    ),
    index('api_request_logs_request_id_idx').on(t.merchantId, t.requestId, t.createdAt.desc()),
    check('api_request_logs_environment_check', sql`${t.environment} in ('test', 'live')`),
    check('api_request_logs_status_check', sql`${t.statusCode} between 100 and 599`),
    check('api_request_logs_latency_check', sql`${t.latencyMs} >= 0`),
  ]
);
