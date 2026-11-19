/**
 * `/v1/payouts` (spec 7.2). Public API for payouts (disbursements).
 * Requires `payouts:read` and `payouts:write` scopes.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEmits, ApiErrors, ApiExample } from '../../common/openapi/api-docs.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { IdempotencyKey, Idempotent } from '../../common/idempotency/idempotent.decorator';
import type { IdempotencyContext } from '../../common/idempotency/idempotency.types';
import { PayoutsService } from '../../modules/payouts/payouts.service';
import { refParamSchema } from '../shared/schemas';

// Zod schemas for request/response
const createPayoutSchema = z.object({
  amountMinor: z.string().regex(/^\d+$/),
  currency: z.string().length(3),
  channel: z.enum(['mobile_money', 'bank']),
  destination: z.object({
    type: z.enum(['msisdn', 'bank_account']),
    value: z.string().min(1).max(100),
    name: z.string().min(1).max(100).optional(),
  }),
  description: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const listPayoutsSchema = z.object({
  status: z
    .enum(['created', 'pending_approval', 'processing', 'succeeded', 'failed', 'expired', 'cancelled'])
    .optional(),
  currency: z.string().length(3).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().optional(),
});

const payoutViewSchema = z.object({
  id: z.string(),
  ref: z.string(),
  transactionRef: z.string(),
  merchantId: z.string(),
  environment: z.enum(['test', 'live']),
  amountMinor: z.string(),
  currency: z.string(),
  channel: z.string(),
  destination: z.unknown(),
  status: z.enum([
    'created',
    'pending_approval',
    'processing',
    'succeeded',
    'failed',
    'expired',
    'cancelled',
  ]),
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const payoutPageSchema = z.object({
  data: z.array(payoutViewSchema),
  pagination: z.object({
    limit: z.number(),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

class CreatePayoutDto extends createZodDto(createPayoutSchema) {}
class ListPayoutsDto extends createZodDto(listPayoutsSchema) {}
class PayoutParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Payouts')
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('payouts:write')
  @ApiErrors(
    'PAYOUT_REQUEST_INVALID',
    'MERCHANT_INACTIVE',
    'MERCHANT_SUSPENDED',
    'PAYOUT_AMOUNT_EXCEEDS_LIMIT',
    'INSUFFICIENT_BALANCE'
  )
  @ApiEmits('payout.created', 'payout.pending_approval', 'payout.succeeded', 'payout.failed')
  @ApiExample({
    request: {
      amountMinor: '50000',
      currency: 'UGX',
      channel: 'mobile_money',
      destination: {
        type: 'msisdn',
        value: '+256700000001',
        name: 'John Doe',
      },
      description: 'Payout for services',
      metadata: { invoiceId: 'INV-001' },
    },
    response: {
      id: 'po_01JBX7Q2M4N8R5T6V9W0XYZABC',
      ref: 'po_01JBX7Q2M4N8R5T6V9W0XYZABC',
      transactionRef: 'txn_01JBX7Q2M4N8R5T6V9W0XYZABD',
      environment: 'test',
      status: 'created',
      amountMinor: '50000',
      currency: 'UGX',
      channel: 'mobile_money',
      destination: { type: 'msisdn', value: '+256700000001', name: 'John Doe' },
      description: 'Payout for services',
      metadata: { invoiceId: 'INV-001' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
  })
  @Idempotent('payouts.create')
  @Audited('payout.created', 'payout')
  @ApiOperation({
    summary: 'Create a payout',
    description:
      'Requires an `Idempotency-Key`. Creates a payout and places a hold on the merchant balance. ' +
      'If the amount exceeds the approval threshold, the payout enters `pending_approval` status ' +
      'and requires manual approval before submission to the gateway.',
  })
  @ApiEnvelopedResponses({ 201: payoutViewSchema })
  async create(
    @Body() body: CreatePayoutDto,
    @CurrentApiKey() key: ApiKeyPrincipal,
    @IdempotencyKey() idempotency: IdempotencyContext
  ) {
    const scope = scopeOfApiKey(key);
    return this.payouts.create(scope, {
      amountMinor: BigInt(body.amountMinor),
      currency: body.currency,
      channel: body.channel,
      destination: body.destination,
      description: body.description,
      metadata: body.metadata,
      idempotencyKey: idempotency.key,
    });
  }

  @Get(':ref')
  @RequirePermission('payouts:read')
  @ApiErrors('NOT_FOUND')
  @ApiOperation({
    summary: 'Retrieve a payout',
    description: 'Get a single payout by its reference.',
  })
  @ApiEnvelopedResponses({ 200: payoutViewSchema })
  async get(@Param() params: PayoutParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    const scope = scopeOfApiKey(key);
    return this.payouts.get(scope, params.ref);
  }

  @Get()
  @RequirePermission('payouts:read')
  @ApiOperation({
    summary: 'List payouts',
    description: 'List payouts with optional filtering by status, currency, and date range.',
  })
  @ApiEnvelopedResponses({ 200: payoutPageSchema })
  async list(@Query() query: ListPayoutsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    const scope = scopeOfApiKey(key);
    return this.payouts.list(scope, {
      status: query.status,
      currency: query.currency,
      from: query.from,
      to: query.to,
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
