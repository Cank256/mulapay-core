/**
 * Incidents (spec 5.2). Phase 6 only opens them: a ledger integrity failure opens a sev1
 * automatically (spec 6.8). The lifecycle (updates, postmortems, the status feed) is Phase 8
 * and builds on this table, so the spec's columns are all here.
 *
 * `dedupe_key` and the detection counters are Phase 6 additions: an hourly run that keeps
 * seeing the same failure updates one open incident instead of paging every hour.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';

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
    check('incidents_source_check', sql`${t.source} in ('manual', 'reconciliation', 'consumer')`),
  ]
);
