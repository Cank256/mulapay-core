import { describe, expect, it } from 'vitest';
import {
  COMPLAINT_STATUSES,
  canMerchantClose,
  isOverdue,
  isTerminal,
  nextStatus,
  resolvedLate,
  slaDueAt,
  type ComplaintAction,
  type ComplaintStatus,
} from './complaint-rules';

const ACTIONS: ComplaintAction[] = [
  'assign',
  'reply_staff',
  'reply_merchant',
  'await_customer',
  'escalate',
  'resolve',
  'close',
];

describe('complaint SLA', () => {
  it('is the creation time plus the category hours, in calendar time', () => {
    const created = new Date('2025-03-01T10:00:00Z');
    expect(slaDueAt(created, 24).toISOString()).toBe('2025-03-02T10:00:00.000Z');
    expect(slaDueAt(created, 8).toISOString()).toBe('2025-03-01T18:00:00.000Z');
  });

  it('is overdue only while unresolved and past the deadline', () => {
    const due = new Date('2025-03-01T12:00:00Z');
    const before = new Date('2025-03-01T11:59:59Z');
    const after = new Date('2025-03-01T12:00:01Z');
    expect(isOverdue({ status: 'open', slaDueAt: due }, before)).toBe(false);
    expect(isOverdue({ status: 'open', slaDueAt: due }, due)).toBe(false);
    expect(isOverdue({ status: 'in_progress', slaDueAt: due }, after)).toBe(true);
    expect(isOverdue({ status: 'resolved', slaDueAt: due }, after)).toBe(false);
    expect(isOverdue({ status: 'closed', slaDueAt: due }, after)).toBe(false);
  });

  it('counts a late resolution as a breach', () => {
    const due = new Date('2025-03-01T12:00:00Z');
    expect(resolvedLate(due, new Date('2025-03-01T12:00:00Z'))).toBe(false);
    expect(resolvedLate(due, new Date('2025-03-01T12:00:01Z'))).toBe(true);
  });
});

describe('complaint status machine', () => {
  it('never leaves closed', () => {
    for (const action of ACTIONS) expect(nextStatus('closed', action)).toBeNull();
  });

  it('moves open to in_progress on assignment or a staff reply, and never back to open', () => {
    expect(nextStatus('open', 'assign')).toBe('in_progress');
    expect(nextStatus('open', 'reply_staff')).toBe('in_progress');
    for (const from of COMPLAINT_STATUSES.filter((s) => s !== 'open')) {
      for (const action of ACTIONS) expect(nextStatus(from, action)).not.toBe('open');
    }
  });

  it('returns to in_progress when the customer or merchant answers', () => {
    expect(nextStatus('awaiting_customer', 'reply_merchant')).toBe('in_progress');
    expect(nextStatus('in_progress', 'reply_merchant')).toBe('in_progress');
    expect(nextStatus('resolved', 'reply_merchant')).toBeNull();
  });

  it('only waits for the customer, or escalates, from a working status', () => {
    for (const from of ['open', 'in_progress', 'awaiting_customer'] as ComplaintStatus[]) {
      expect(nextStatus(from, 'await_customer')).toBe('awaiting_customer');
      expect(nextStatus(from, 'escalate')).toBe('escalated');
    }
    for (const from of ['escalated', 'resolved'] as ComplaintStatus[]) {
      expect(nextStatus(from, 'await_customer')).toBeNull();
      expect(nextStatus(from, 'escalate')).toBeNull();
    }
  });

  it('resolves from anywhere not already resolved, and resolved only closes', () => {
    for (const from of [
      'open',
      'in_progress',
      'awaiting_customer',
      'escalated',
    ] as ComplaintStatus[]) {
      expect(nextStatus(from, 'resolve')).toBe('resolved');
    }
    expect(nextStatus('resolved', 'resolve')).toBeNull();
    expect(nextStatus('resolved', 'close')).toBe('closed');
    expect(nextStatus('resolved', 'reply_staff')).toBeNull();
    expect(nextStatus('resolved', 'assign')).toBeNull();
  });

  it('keeps an escalated complaint escalated when someone is assigned or replies', () => {
    expect(nextStatus('escalated', 'assign')).toBe('escalated');
    expect(nextStatus('escalated', 'reply_staff')).toBe('escalated');
  });

  it('knows which statuses are final for the SLA, and who may close', () => {
    expect(isTerminal('resolved')).toBe(true);
    expect(isTerminal('closed')).toBe(true);
    expect(isTerminal('escalated')).toBe(false);
    expect(canMerchantClose('resolved')).toBe(true);
    expect(canMerchantClose('closed')).toBe(false);
  });
});
