import { describe, expect, it } from 'vitest';
import {
  canTransitionSession,
  CHECKOUT_SESSION_STATUSES,
  linkUnavailableReason,
  sessionUnavailableReason,
} from './link-and-session';

const NOW = new Date('2025-06-01T12:00:00Z');
const open = { active: true, expiresAt: null, maxUses: null, usedCount: 0 };

describe('linkUnavailableReason', () => {
  it('accepts an active link with room left', () => {
    expect(linkUnavailableReason(open, NOW)).toBeNull();
    expect(linkUnavailableReason({ ...open, maxUses: 3, usedCount: 2 }, NOW)).toBeNull();
    expect(
      linkUnavailableReason({ ...open, expiresAt: new Date('2025-06-01T12:00:01Z') }, NOW)
    ).toBeNull();
  });

  it('rejects an inactive link first', () => {
    expect(linkUnavailableReason({ ...open, active: false, maxUses: 1, usedCount: 1 }, NOW)).toBe(
      'inactive'
    );
  });

  it('rejects a link at or past its expiry', () => {
    expect(linkUnavailableReason({ ...open, expiresAt: NOW }, NOW)).toBe('expired');
    expect(linkUnavailableReason({ ...open, expiresAt: new Date('2025-01-01') }, NOW)).toBe(
      'expired'
    );
  });

  it('rejects a link whose max_uses is reached', () => {
    expect(linkUnavailableReason({ ...open, maxUses: 2, usedCount: 2 }, NOW)).toBe(
      'max_uses_reached'
    );
    expect(linkUnavailableReason({ ...open, maxUses: 2, usedCount: 3 }, NOW)).toBe(
      'max_uses_reached'
    );
  });
});

describe('checkout sessions', () => {
  it('moves from open to complete or expired, and nowhere else', () => {
    for (const from of CHECKOUT_SESSION_STATUSES) {
      for (const to of CHECKOUT_SESSION_STATUSES) {
        const expected = from === 'open' && (to === 'complete' || to === 'expired');
        expect(canTransitionSession(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('reports why a session cannot start a payment', () => {
    const future = new Date('2025-06-02T00:00:00Z');
    expect(sessionUnavailableReason({ status: 'open', expiresAt: future }, NOW)).toBeNull();
    expect(sessionUnavailableReason({ status: 'complete', expiresAt: future }, NOW)).toBe(
      'complete'
    );
    expect(sessionUnavailableReason({ status: 'expired', expiresAt: future }, NOW)).toBe('expired');
    expect(sessionUnavailableReason({ status: 'open', expiresAt: NOW }, NOW)).toBe('expired');
  });
});
