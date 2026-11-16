import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import { classifyScreening, blocksActivation } from './screening-classification';
import { isOverdue, nextAlertStatus } from './alert-state';
import { alertDueAt } from './sla';

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return (e.details as { reason: string }).reason;
    throw e;
  }
  return 'allowed';
}

describe('alert workflow', () => {
  it('moves open to investigating when assigned, and leaves an escalated alert escalated', () => {
    expect(nextAlertStatus('open', 'assign')).toBe('investigating');
    expect(nextAlertStatus('investigating', 'assign')).toBe('investigating');
    expect(nextAlertStatus('escalated', 'assign')).toBe('escalated');
  });
  it('escalates once', () => {
    expect(nextAlertStatus('open', 'escalate')).toBe('escalated');
    expect(nextAlertStatus('investigating', 'escalate')).toBe('escalated');
    expect(reason(() => nextAlertStatus('escalated', 'escalate'))).toBe('already_escalated');
  });
  it('resolves from any open state with an outcome', () => {
    expect(nextAlertStatus('escalated', 'resolve', 'closed_confirmed')).toBe('closed_confirmed');
    expect(nextAlertStatus('open', 'resolve', 'closed_false_positive')).toBe(
      'closed_false_positive'
    );
    expect(reason(() => nextAlertStatus('open', 'resolve'))).toBe('outcome_required');
  });
  it('refuses everything on a closed alert', () => {
    for (const action of ['assign', 'escalate', 'resolve'] as const) {
      expect(reason(() => nextAlertStatus('closed_confirmed', action, 'closed_confirmed'))).toBe(
        'alert_closed'
      );
    }
  });
  it('is overdue only while unworked by a decision or escalation', () => {
    const due = new Date('2025-01-01T10:00:00Z');
    const now = new Date('2025-01-01T10:00:00Z');
    expect(isOverdue({ status: 'open', dueAt: due }, now)).toBe(true);
    expect(isOverdue({ status: 'investigating', dueAt: due }, now)).toBe(true);
    expect(isOverdue({ status: 'escalated', dueAt: due }, now)).toBe(false);
    expect(isOverdue({ status: 'closed_confirmed', dueAt: due }, now)).toBe(false);
    expect(isOverdue({ status: 'open', dueAt: new Date(now.getTime() + 1) }, now)).toBe(false);
  });
  it('sets the due time from the severity', () => {
    const config = {
      AML_ALERT_SLA_HOURS_LOW: 72,
      AML_ALERT_SLA_HOURS_MEDIUM: 24,
      AML_ALERT_SLA_HOURS_HIGH: 8,
      AML_ALERT_SLA_HOURS_CRITICAL: 4,
    };
    const at = new Date('2025-01-01T00:00:00Z');
    expect(alertDueAt('critical', at, config).toISOString()).toBe('2025-01-01T04:00:00.000Z');
    expect(alertDueAt('low', at, config).toISOString()).toBe('2025-01-04T00:00:00.000Z');
  });
});

describe('screening classification', () => {
  const thresholds = { review: 0.7, confirm: 0.9 };
  const hit = (score: number, categories: Array<'sanctions' | 'pep'> = ['sanctions']) => ({
    entityId: `E${score}`,
    caption: 'x',
    score,
    categories,
    datasets: [],
  });
  it('is clear with no hit, or only hits below the review score', () => {
    expect(classifyScreening([], thresholds)).toMatchObject({
      status: 'clear',
      hitCount: 0,
      highestScore: null,
    });
    expect(classifyScreening([hit(0.69)], thresholds).status).toBe('clear');
  });
  it('needs review from the review score, and is confirmed from the confirm score', () => {
    expect(classifyScreening([hit(0.7)], thresholds).status).toBe('potential_match');
    expect(classifyScreening([hit(0.89)], thresholds).status).toBe('potential_match');
    expect(classifyScreening([hit(0.9)], thresholds).status).toBe('confirmed_match');
  });
  it('reports the strongest score and the lists of the hits that count', () => {
    const result = classifyScreening(
      [hit(0.4, ['pep']), hit(0.95, ['sanctions']), hit(0.8, ['pep'])],
      thresholds
    );
    expect(result).toMatchObject({
      status: 'confirmed_match',
      hitCount: 2,
      highestScore: 0.95,
      lists: ['pep', 'sanctions'],
    });
    expect(result.hits.map((h) => h.score)).toEqual([0.95, 0.8]);
  });
  it('blocks activation for anything but clear', () => {
    expect(blocksActivation('clear')).toBe(false);
    expect(blocksActivation('potential_match')).toBe(true);
    expect(blocksActivation('confirmed_match')).toBe(true);
  });
});
