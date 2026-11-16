/**
 * Support (spec 5.2, 6.14, Phase 8): complaints with category-driven SLAs, their message
 * threads (with internal-only notes), and the investigation notes of a dispute.
 *
 * Database rules added by migration 0008 (the domain checks them first):
 *  - what a complaint is about (source, merchant, category, transaction, creation time and
 *    the SLA deadline) never changes; a closed complaint is final;
 *  - messages and dispute notes are append-only.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { disputes } from './disputes';
import { users } from './identity';
import { merchants } from './merchants';
import { transactionKeys } from './transactions';

export const COMPLAINT_SOURCES = ['merchant', 'customer', 'admin'] as const;
export const COMPLAINT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const COMPLAINT_STATUSES = [
  'open',
  'in_progress',
  'awaiting_customer',
  'escalated',
  'resolved',
  'closed',
] as const;
export const COMPLAINT_AUTHOR_TYPES = ['merchant', 'admin', 'system', 'customer'] as const;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** The SLA is data: each category carries the hours a complaint may stay unresolved. */
export const complaintCategories = core.table(
  'complaint_categories',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    slaHours: integer('sla_hours').notNull(),
    defaultPriority: text('default_priority').notNull().default('normal'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('complaint_categories_code_check', sql`${t.code} ~ '^[a-z][a-z0-9_]{1,40}$'`),
    check('complaint_categories_sla_check', sql`${t.slaHours} between 1 and 2160`),
    check(
      'complaint_categories_priority_check',
      sql`${t.defaultPriority} in (${list(COMPLAINT_PRIORITIES)})`
    ),
  ]
);

export const complaints = core.table(
  'complaints',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    /** The merchant the complaint is filed by, or is about (a customer complaint). */
    merchantId: uuid('merchant_id').references(() => merchants.id),
    source: text('source').notNull(),
    category: text('category')
      .notNull()
      .references(() => complaintCategories.code),
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    transactionId: uuid('transaction_id').references(() => transactionKeys.id),
    /** AES-256-GCM (FieldEncryption), bound to the complaint id. A customer's phone or email. */
    customerContactEnc: text('customer_contact_enc'),
    priority: text('priority').notNull(),
    status: text('status').notNull().default('open'),
    /** `created_at` plus the category's SLA hours. Never changes. */
    slaDueAt: timestamptz('sla_due_at').notNull(),
    breached: boolean('breached').notNull().default(false),
    breachedAt: timestamptz('breached_at'),
    breachNotifiedAt: timestamptz('breach_notified_at'),
    assignedTo: uuid('assigned_to').references(() => users.id),
    assignedAt: timestamptz('assigned_at'),
    escalatedAt: timestamptz('escalated_at'),
    escalationReason: text('escalation_reason'),
    resolution: text('resolution'),
    resolvedAt: timestamptz('resolved_at'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    closedAt: timestamptz('closed_at'),
    satisfactionScore: smallint('satisfaction_score'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('complaints_ref_key').on(t.ref),
    index('complaints_merchant_idx').on(t.merchantId, t.createdAt.desc(), t.ref.desc()),
    index('complaints_queue_idx').on(t.status, t.priority, t.createdAt.desc()),
    index('complaints_sla_idx')
      .on(t.slaDueAt)
      .where(sql`${t.status} not in ('resolved', 'closed') and not ${t.breached}`),
    index('complaints_breached_idx')
      .on(t.breachedAt.desc())
      .where(sql`${t.breached} and ${t.status} not in ('resolved', 'closed')`),
    index('complaints_assignee_idx')
      .on(t.assignedTo, t.status)
      .where(sql`${t.assignedTo} is not null`),
    index('complaints_transaction_idx')
      .on(t.transactionId)
      .where(sql`${t.transactionId} is not null`),
    check('complaints_ref_check', sql`${t.ref} ~ '^cmp_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check('complaints_source_check', sql`${t.source} in (${list(COMPLAINT_SOURCES)})`),
    check('complaints_priority_check', sql`${t.priority} in (${list(COMPLAINT_PRIORITIES)})`),
    check('complaints_status_check', sql`${t.status} in (${list(COMPLAINT_STATUSES)})`),
    check('complaints_subject_check', sql`char_length(${t.subject}) between 1 and 200`),
    check('complaints_description_check', sql`char_length(${t.description}) between 1 and 5000`),
    // A merchant files its own complaint, so a merchant-sourced complaint has a merchant.
    check(
      'complaints_merchant_source_check',
      sql`${t.source} <> 'merchant' or ${t.merchantId} is not null`
    ),
    check(
      'complaints_resolved_check',
      sql`(${t.status} in ('resolved', 'closed')) = (${t.resolvedAt} is not null or ${t.closedAt} is not null)`
    ),
    check('complaints_breach_check', sql`${t.breached} = (${t.breachedAt} is not null)`),
    check(
      'complaints_satisfaction_check',
      sql`${t.satisfactionScore} is null or ${t.satisfactionScore} between 1 and 5`
    ),
  ]
);

/** The thread. Internal notes are never shown to a merchant. Append-only. */
export const complaintMessages = core.table(
  'complaint_messages',
  {
    id: uuid('id').primaryKey(),
    complaintId: uuid('complaint_id')
      .notNull()
      .references(() => complaints.id),
    authorType: text('author_type').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    body: text('body').notNull(),
    attachments: jsonb('attachments')
      .$type<Array<{ name: string; key: string }>>()
      .notNull()
      .default([]),
    internal: boolean('internal').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('complaint_messages_thread_idx').on(t.complaintId, t.createdAt, t.id),
    check(
      'complaint_messages_author_type_check',
      sql`${t.authorType} in (${list(COMPLAINT_AUTHOR_TYPES)})`
    ),
    check('complaint_messages_body_check', sql`char_length(${t.body}) between 1 and 5000`),
    // A merchant or a customer cannot write something only staff can read.
    check(
      'complaint_messages_internal_check',
      sql`not ${t.internal} or ${t.authorType} in ('admin', 'system')`
    ),
  ]
);

/** Investigators' notes on a dispute. Staff only, append-only. */
export const disputeNotes = core.table(
  'dispute_notes',
  {
    id: uuid('id').primaryKey(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('dispute_notes_dispute_idx').on(t.disputeId, t.createdAt, t.id),
    check('dispute_notes_body_check', sql`char_length(${t.body}) between 1 and 2000`),
  ]
);
