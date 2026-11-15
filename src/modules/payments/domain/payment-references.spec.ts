import { describe, expect, it } from 'vitest';
import {
  gatewayExternalIdFor,
  isCheckoutSessionRef,
  isPaymentLinkRef,
  isPaymentRef,
  isTransactionRef,
  newPaymentIds,
} from './payment-references';
import { publicId } from '../../../common/ids/ids';

describe('payment references', () => {
  it('generates distinct, correctly prefixed ids for a payment and its transaction', () => {
    const ids = newPaymentIds(new Date('2025-03-01T00:00:00Z'));
    expect(ids.paymentRef).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ids.transactionRef).toMatch(/^txn_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ids.paymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set([ids.paymentId, ids.transactionId]).size).toBe(2);
    expect(newPaymentIds(new Date()).paymentRef).not.toBe(ids.paymentRef);
  });

  it('uses the payment reference as the gateway external id, with no attempt suffix', () => {
    const { paymentRef } = newPaymentIds(new Date());
    expect(gatewayExternalIdFor(paymentRef)).toBe(paymentRef);
    expect(gatewayExternalIdFor(paymentRef)).toBe(gatewayExternalIdFor(paymentRef));
  });

  it('recognises each reference kind and no other', () => {
    const now = new Date();
    expect(isPaymentRef(publicId('payment', now))).toBe(true);
    expect(isTransactionRef(publicId('transaction', now))).toBe(true);
    expect(isPaymentLinkRef(publicId('paymentLink', now))).toBe(true);
    expect(isCheckoutSessionRef(publicId('checkoutSession', now))).toBe(true);
    expect(isPaymentRef(publicId('transaction', now))).toBe(false);
    expect(isPaymentRef('pay_nope')).toBe(false);
  });
});
