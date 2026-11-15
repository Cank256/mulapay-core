/**
 * Merchant-facing shapes of payments, payment links and checkout sessions (spec 6.1).
 * Internal ids, the encrypted phone number, failure reasons and the client secret hash
 * never leave the service. The phone number is shown as its last four digits only.
 */
import { z } from 'zod';
import { PAYMENT_STATUSES } from './domain/payment-state-machine';
import type { CheckoutSessionWithPayment } from './checkout-sessions.repository';
import type { PaymentLinkRow } from './payment-links.repository';
import type { PaymentDetail } from './payments.repository';

const environmentSchema = z.enum(['test', 'live']);

export const paymentSchema = z.object({
  id: z.string(),
  transactionId: z.string(),
  environment: environmentSchema,
  status: z.enum(PAYMENT_STATUSES),
  amountMinor: z.string(),
  currency: z.string(),
  channel: z.enum(['mobile_money', 'card', 'bank']),
  provider: z.string().nullable(),
  paymentMethod: z.object({
    provider: z.string().nullable(),
    msisdnLast4: z.string().nullable(),
  }),
  description: z.string().nullable(),
  statementDescriptor: z.string().nullable(),
  returnUrl: z.string().nullable(),
  paymentLinkId: z.string().nullable(),
  checkoutSessionId: z.string().nullable(),
  failureCode: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
});
export type PaymentView = z.infer<typeof paymentSchema>;

export const paymentPageSchema = z.object({
  items: z.array(paymentSchema),
  nextCursor: z.string().nullable(),
});

export function toPaymentView({
  payment,
  transaction,
  paymentLinkRef,
  checkoutSessionRef,
}: PaymentDetail): PaymentView {
  return {
    id: payment.ref,
    transactionId: transaction.ref,
    environment: payment.environment as PaymentView['environment'],
    status: payment.status as PaymentView['status'],
    amountMinor: payment.amountMinor.toString(),
    currency: payment.currency,
    channel: payment.channel as PaymentView['channel'],
    provider: transaction.provider,
    paymentMethod: {
      provider: payment.paymentMethod.provider ?? null,
      msisdnLast4: payment.paymentMethod.msisdnLast4 ?? null,
    },
    description: payment.description,
    statementDescriptor: payment.statementDescriptor,
    returnUrl: payment.returnUrl,
    paymentLinkId: paymentLinkRef,
    checkoutSessionId: checkoutSessionRef,
    failureCode: transaction.failureCode,
    expiresAt: payment.expiresAt.toISOString(),
    completedAt: transaction.completedAt?.toISOString() ?? null,
    metadata: payment.metadata,
    createdAt: payment.createdAt.toISOString(),
  };
}

export const paymentLinkSchema = z.object({
  id: z.string(),
  environment: environmentSchema,
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  amountMinor: z.string().nullable(),
  currency: z.string(),
  active: z.boolean(),
  maxUses: z.number().int().nullable(),
  usedCount: z.number().int(),
  expiresAt: z.iso.datetime().nullable(),
  successUrl: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
});
export type PaymentLinkView = z.infer<typeof paymentLinkSchema>;

export const paymentLinkPageSchema = z.object({
  items: z.array(paymentLinkSchema),
  nextCursor: z.string().nullable(),
});

export function toPaymentLinkView(row: PaymentLinkRow): PaymentLinkView {
  return {
    id: row.ref,
    environment: row.environment as PaymentLinkView['environment'],
    slug: row.slug,
    title: row.title,
    description: row.description,
    amountMinor: row.amountMinor === null ? null : row.amountMinor.toString(),
    currency: row.currency,
    active: row.active,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    successUrl: row.successUrl,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

export const checkoutSessionSchema = z.object({
  id: z.string(),
  environment: environmentSchema,
  status: z.enum(['open', 'complete', 'expired']),
  amountMinor: z.string(),
  currency: z.string(),
  description: z.string().nullable(),
  successUrl: z.string().nullable(),
  paymentId: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
});
export type CheckoutSessionView = z.infer<typeof checkoutSessionSchema>;

/**
 * Creation returns the client secret once; only its hash is stored. An idempotent replay of
 * the creation request returns `null` in its place: the secret is never kept in clear.
 */
export const createdCheckoutSessionSchema = checkoutSessionSchema.extend({
  clientSecret: z.string().nullable(),
});
export type CreatedCheckoutSessionView = z.infer<typeof createdCheckoutSessionSchema>;

export function toCheckoutSessionView({
  session,
  paymentRef,
}: CheckoutSessionWithPayment): CheckoutSessionView {
  return {
    id: session.ref,
    environment: session.environment as CheckoutSessionView['environment'],
    status: session.status as CheckoutSessionView['status'],
    amountMinor: session.amountMinor.toString(),
    currency: session.currency,
    description: session.description,
    successUrl: session.successUrl,
    paymentId: paymentRef,
    expiresAt: session.expiresAt.toISOString(),
    completedAt: session.completedAt?.toISOString() ?? null,
    metadata: session.metadata,
    createdAt: session.createdAt.toISOString(),
  };
}
