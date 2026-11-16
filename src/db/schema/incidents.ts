/**
 * Incidents (spec 5.2). Phase 6 only opens them: a ledger integrity failure opens a sev1
 * automatically (spec 6.8). The lifecycle (updates, postmortems, the status feed) is Phase 8
 * and builds on this table, so the spec's columns are all here.
 *
 * `dedupe_key` and the detection counters are Phase 6 additions: an hourly run that keeps
 * seeing the same failure updates one open incident instead of paging every hour.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { users } from './identity';

export const incidents = core.table(
  'incidents',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('investigating'),
    impact: text('impact').notNull(),
    affectedServices: text('affected_services')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    affectedMerchants: uuid('affected_merchants')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    startedAt: timestamptz('started_at').notNull(),
    detectedAt: timestamptz('detected_at').notNull(),
    resolvedAt: timestamptz('resolved_at'),
    commander: uuid('commander'),
    public: boolean('public').notNull().default(false),
    publicMessage: text('public_message'),
    source: text('source').notNull().default('manual'),
    dedupeKey: text('dedupe_key'),
    detectionCount: integer('detection_count').notNull().default(1),
    lastDetectedAt: timestamptz('last_detected_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('incidents_ref_key').on(t.ref),
    uniqueIndex('incidents_open_dedupe_key')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} <> 'resolved'`),
    index('incidents_status_idx').on(t.status, t.severity, t.detectedAt.desc()),
    check('incidents_ref_format_check', sql`${t.ref} ~ '^inc_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('incidents_severity_check', sql`${t.severity} in ('sev1', 'sev2', 'sev3', 'sev4')`),
    check(
      'incidents_status_check',
      sql`${t.status} in ('investigating', 'identified', 'monitoring', 'resolved')`
    ),
    check(
      'incidents_resolved_check',
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} is not null)`
    ),
    check(
      'incidents_source_check',
      sql`${t.source} in ('manual', 'reconciliation', 'consumer', 'monitor')`
    ),
    index('incidents_public_idx')
      .on(t.detectedAt.desc())
      .where(sql`${t.public}`),
    // Anything on the public status page has a public headline.
    check('incidents_public_message_check', sql`not ${t.public} or ${t.publicMessage} is not null`),
  ]
);

/**
 * The incident timeline (spec 5.2). Every row is internal unless `public`; only public rows
 * reach the status feed. Append-only: a correction is a new update.
 */
export const incidentUpdates = core.table(
  'incident_updates',
  {
    id: uuid('id').primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id),
    /** The incident's status when the update was written. */
    status: text('status').notNull(),
    body: text('body').notNull(),
    public: boolean('public').notNull().default(false),
    /** Null for an update the platform wrote itself (a monitor). */
    authorId: uuid('author_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('incident_updates_incident_idx').on(t.incidentId, t.createdAt, t.id),
    index('incident_updates_public_idx')
      .on(t.incidentId, t.createdAt)
      .where(sql`${t.public}`),
    check(
      'incident_updates_status_check',
      sql`${t.status} in ('investigating', 'identified', 'monitoring', 'resolved')`
    ),
    check('incident_updates_body_check', sql`char_length(${t.body}) between 1 and 4000`),
  ]
);

/** One postmortem per incident. Editable until published, then final. Never public. */
export const incidentPostmortems = core.table(
  'incident_postmortems',
  {
    id: uuid('id').primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id),
    summary: text('summary').notNull(),
    rootCause: text('root_cause').notNull(),
    timeline: jsonb('timeline').$type<Array<{ at: string; event: string }>>().notNull().default([]),
    actionItems: jsonb('action_items')
      .$type<Array<{ title: string; owner: string | null; due: string | null }>>()
      .notNull()
      .default([]),
    publishedAt: timestamptz('published_at'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('incident_postmortems_incident_key').on(t.incidentId),
    check('incident_postmortems_summary_check', sql`char_length(${t.summary}) between 1 and 8000`),
  ]
);
