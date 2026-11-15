/**
 * Request schema pieces for the payment, payment link, checkout session and transaction
 * routes, shared by the public and dashboard surfaces. Strict by default; the schemas are
 * built once at module load (spec 9.2 rule 2).
 *
 * Amounts are positive integers in minor units, sent as a digit string (always safe) or a
 * JSON integer up to 2^53 - 1. A JSON number cannot carry every bigint, which is why
 * responses use strings.
 */
import { z } from 'zod';
import { MAX_MINOR } from '../../common/money/minor-units';
import { MAX_PAGE_LIMIT, pageQuerySchema } from '../../common/pagination/cursor';
import { PAYMENT_PROVIDERS } from '../../modules/payments/domain/payment-event';
import { normalizeMsisdn } from '../../modules/payments/domain/payment-input';
import { PAYMENT_STATUSES } from '../../modules/payments/domain/payment-state-machine';
import { TRANSACTION_TYPES } from '../../modules/transactions/transactions.service';
import { currencySchema, metadataSchema } from './schemas';

const DIGITS = /^[1-9][0-9]{0,18}$/;

export const amountMinorSchema = z
  .union([
    z.string().regex(DIGITS, 'must be a positive integer in minor units'),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_MINOR, 'is too large');

/** An amount filter in a query string: digits only. */
export const amountQuerySchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/, 'must be an integer in minor units')
  .transform((value) => BigInt(value))
  .refine((value) => value <= MAX_MINOR, 'is too large');

export const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const channelSchema = z.enum(['mobile_money', 'card', 'bank']);
export const environmentSchema = z.enum(['test', 'live']);
export const providerSchema = z.enum(PAYMENT_PROVIDERS);
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

export const msisdnSchema = z
  .string()
  .max(32)
  .refine(
    (value) => normalizeMsisdn(value) !== null,
    'must be a phone number in international format, for example +256700000000'
  );

export const httpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

export const paymentMethodSchema = z.strictObject({
  provider: providerSchema.optional(),
  msisdn: msisdnSchema.optional(),
});

export const createPaymentSchema = z.strictObject({
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  channel: channelSchema.default('mobile_money'),
  paymentMethod: paymentMethodSchema.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  statementDescriptor: z.string().trim().min(1).max(22).optional(),
  returnUrl: httpUrlSchema.optional(),
  metadata: metadataSchema.optional(),
});

export const createPaymentLinkSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(1000).optional(),
  amountMinor: amountMinorSchema.optional(),
  currency: currencySchema,
  maxUses: z.number().int().min(1).max(1_000_000).optional(),
  expiresAt: dateTimeSchema.optional(),
  successUrl: httpUrlSchema.optional(),
  metadata: metadataSchema.optional(),
});

export const updatePaymentLinkSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(1000).nullable().optional(),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().optional(),
    expiresAt: dateTimeSchema.nullable().optional(),
    successUrl: httpUrlSchema.nullable().optional(),
    metadata: metadataSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

export const createCheckoutSessionSchema = z.strictObject({
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  description: z.string().trim().min(1).max(500).optional(),
  successUrl: httpUrlSchema.optional(),
  expiresInMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .optional(),
  metadata: metadataSchema.optional(),
});

export const listPaymentsSchema = z.strictObject({
  status: paymentStatusSchema.optional(),
  currency: currencySchema.optional(),
  channel: channelSchema.optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

export const listTransactionsSchema = z.strictObject({
  type: z.enum(TRANSACTION_TYPES).optional(),
  status: z.string().min(1).max(32).optional(),
  currency: currencySchema.optional(),
  provider: providerSchema.optional(),
  channel: channelSchema.optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  minAmountMinor: amountQuerySchema.optional(),
  maxAmountMinor: amountQuerySchema.optional(),
  reference: z.string().min(1).max(128).optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

export const listPaymentLinksSchema = z.strictObject({
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

/** The dashboard picks the environment per request; API keys carry it. */
export const listDashboardPaymentsSchema = listPaymentsSchema.extend({
  environment: environmentSchema.default('live'),
});
export const listDashboardTransactionsSchema = listTransactionsSchema.extend({
  environment: environmentSchema.default('live'),
});
