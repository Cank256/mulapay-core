/**
 * Pure rules of complaints (spec 6.14), unit-tested without a database. Mirrored by the
 * `core.guard_complaint` trigger, so no other writer can break them.
 *
 *  - SLA: `sla_due_at = created_at + category.sla_hours` (calendar time, never paused). It is set
 *    once and never changes.
 *  - A complaint is breached once the deadline has passed while it is still unresolved, or when
 *    it was resolved after the deadline. A breach is never undone.
 *  - Status moves: open, in_progress and awaiting_customer move among themselves (never back to
 *    open) and to escalated, resolved or closed; escalated returns to in_progress or goes on to
 *    resolved or closed; resolved goes to closed only; closed is final.
 */
export const COMPLAINT_STATUSES = [
  'open',
  'in_progress',
  'awaiting_customer',
  'escalated',
  'resolved',
  'closed',
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export type ComplaintAction =
  'assign' | 'reply_staff' | 'reply_merchant' | 'await_customer' | 'escalate' | 'resolve' | 'close';

const WORKING: readonly ComplaintStatus[] = ['open', 'in_progress', 'awaiting_customer'];

/** The status after an action, or null when the action is not allowed from `from`. */
export function nextStatus(from: ComplaintStatus, action: ComplaintAction): ComplaintStatus | null {
  if (from === 'closed') return null;
  switch (action) {
    case 'assign':
      return from === 'open'
        ? 'in_progress'
        : WORKING.includes(from) || from === 'escalated'
          ? from
          : null;
    case 'reply_staff':
      return from === 'open' ? 'in_progress' : from === 'resolved' ? null : from;
    case 'reply_merchant':
      return from === 'awaiting_customer' ? 'in_progress' : from === 'resolved' ? null : from;
    case 'await_customer':
      return WORKING.includes(from) ? 'awaiting_customer' : null;
    case 'escalate':
      return WORKING.includes(from) ? 'escalated' : null;
    case 'resolve':
      return from === 'resolved' ? null : 'resolved';
    case 'close':
      return 'closed';
  }
}

export function isTerminal(status: ComplaintStatus): boolean {
  return status === 'resolved' || status === 'closed';
}

export function slaDueAt(createdAt: Date, slaHours: number): Date {
  return new Date(createdAt.getTime() + slaHours * 3_600_000);
}

/** True when an unresolved complaint is past its deadline. */
export function isOverdue(
  complaint: { status: ComplaintStatus; slaDueAt: Date },
  now: Date
): boolean {
  return !isTerminal(complaint.status) && now.getTime() > complaint.slaDueAt.getTime();
}

/** Resolved or closed after the deadline counts as a breach too. */
export function resolvedLate(slaDue: Date, resolvedAt: Date): boolean {
  return resolvedAt.getTime() > slaDue.getTime();
}

export function canMerchantClose(status: ComplaintStatus): boolean {
  return status !== 'closed';
}
