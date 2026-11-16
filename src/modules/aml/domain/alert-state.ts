/**
 * Alert workflow (spec 6.13). Pure; migration 0007 enforces the same shape.
 *
 *   open -> investigating   an analyst is assigned
 *   open | investigating -> escalated     by an analyst, or by the SLA sweep when `due_at` passes
 *   open | investigating | escalated -> closed_false_positive | closed_confirmed
 *
 * A closed alert is final and an alert that has been worked never goes back to `open`.
 */
import { AppError } from '../../../common/errors/app-error';

export const ALERT_STATUSES = [
  'open',
  'investigating',
  'escalated',
  'closed_false_positive',
  'closed_confirmed',
] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export type AlertAction = 'assign' | 'escalate' | 'resolve';
export type ResolveOutcome = 'closed_false_positive' | 'closed_confirmed';

export function isClosed(status: AlertStatus): boolean {
  return status === 'closed_false_positive' || status === 'closed_confirmed';
}

function refuse(reason: string): AppError {
  return new AppError('AML_TRANSITION_INVALID', { messageParams: { reason }, details: { reason } });
}

/** The status after `action`, or a refusal. Assigning an escalated alert keeps it escalated. */
export function nextAlertStatus(
  from: AlertStatus,
  action: AlertAction,
  outcome?: ResolveOutcome
): AlertStatus {
  if (isClosed(from)) throw refuse('alert_closed');
  switch (action) {
    case 'assign':
      return from === 'open' ? 'investigating' : from;
    case 'escalate':
      if (from === 'escalated') throw refuse('already_escalated');
      return 'escalated';
    case 'resolve':
      if (!outcome) throw refuse('outcome_required');
      return outcome;
  }
}

/** Alerts past `due_at` and still unworked by an escalation or a decision. */
export function isOverdue(alert: { status: AlertStatus; dueAt: Date }, now: Date): boolean {
  return (alert.status === 'open' || alert.status === 'investigating') && alert.dueAt <= now;
}
