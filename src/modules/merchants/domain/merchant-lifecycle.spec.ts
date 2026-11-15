import { describe, expect, it } from 'vitest';
import type { MerchantStatus } from '../../../common/auth/principal';
import {
  MERCHANT_STATUSES,
  MERCHANT_TRANSITIONS,
  merchantAllowsLiveKeys,
  merchantAllowsWrites,
  nextMerchantStatus,
  type MerchantEvent,
  type TransitionActor,
} from './merchant-lifecycle';

const LEGAL: Array<[MerchantStatus, MerchantEvent, TransitionActor, MerchantStatus]> = [
  ['draft', 'submit_kyc', 'merchant', 'pending_kyc'],
  ['pending_kyc', 'approve_kyc', 'system', 'active'],
  ['active', 'suspend', 'admin', 'suspended'],
  ['suspended', 'activate', 'admin', 'active'],
  ['suspended', 'close', 'admin', 'closed'],
  ['draft', 'close', 'admin', 'closed'],
  ['pending_kyc', 'close', 'admin', 'closed'],
];

describe('merchant lifecycle', () => {
  it.each(LEGAL)('%s --%s(%s)--> %s', (from, event, actor, to) => {
    expect(nextMerchantStatus(from, event, actor)).toBe(to);
  });

  it('refuses every other (status, event) pair', () => {
    const legal = new Set(LEGAL.map(([from, event]) => `${from}:${event}`));
    const events = Object.keys(MERCHANT_TRANSITIONS) as MerchantEvent[];
    let refused = 0;
    for (const from of MERCHANT_STATUSES) {
      for (const event of events) {
        if (legal.has(`${from}:${event}`)) continue;
        const actor = MERCHANT_TRANSITIONS[event].actor;
        expect(() => nextMerchantStatus(from, event, actor)).toThrow(
          expect.objectContaining({ code: 'MERCHANT_INVALID_TRANSITION' })
        );
        refused++;
      }
    }
    expect(refused).toBe(MERCHANT_STATUSES.length * events.length - LEGAL.length);
  });

  it('refuses a legal transition by the wrong actor', () => {
    expect(() => nextMerchantStatus('active', 'suspend', 'merchant')).toThrow();
    expect(() => nextMerchantStatus('pending_kyc', 'approve_kyc', 'admin')).toThrow();
    expect(() => nextMerchantStatus('draft', 'submit_kyc', 'admin')).toThrow();
  });

  it('closed is terminal and read-only; live keys need active', () => {
    for (const event of Object.keys(MERCHANT_TRANSITIONS) as MerchantEvent[]) {
      expect(() =>
        nextMerchantStatus('closed', event, MERCHANT_TRANSITIONS[event].actor)
      ).toThrow();
    }
    expect(merchantAllowsWrites('closed')).toBe(false);
    expect(merchantAllowsWrites('suspended')).toBe(true);
    expect(MERCHANT_STATUSES.filter(merchantAllowsLiveKeys)).toEqual(['active']);
  });
});
