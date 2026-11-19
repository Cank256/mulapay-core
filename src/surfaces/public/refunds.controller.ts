/**
 * `/v1/refunds` (spec 7.3). Public API for refunds.
 * Requires `refunds:read` and `refunds:write` scopes.
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
import { RefundsService } from '../../modules/refunds/refunds.service';
import { refParamSchema } from '../shared/schemas';

// Zod schemas for request/response
const createRefundSchema = z.object({
  paymentId: z.string().uuid(),
  amountMinor: z.string().regex(/^\d+$/),
  reason: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const listRefundsSchema = z.object({
  status: z
    .enum(['created', 'pending_approval', 'processing', 'succeeded', 'failed', 'cancelled'])
    .optional(),
  currency: z.string().length(3).optional(),
  paymentRef: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().optional(),
});

const refundViewSchema = z.object({
  id: z.string(),
  ref: z.string(),
  transactionRef: z.string(),
  merchantId: z.string(),
  environment: z.enum(['test', 'live']),
  paymentId: z.string(),
  paymentRef: z.string(),
  amountMinor: z.string(),
  currency: z.string(),
  status: z.enum([
    'created',
    'pending_approval',
    'processing',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const refundPageSchema = z.object({
  data: z.array(refundViewSchema),
  pagination: z.object({
    limit: z.number(),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

class CreateRefundDto extends createZodDto(createRefundSchema) {}
class ListRefundsDto extends createZodDto(listRefundsSchema) {}
class RefundParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Refunds')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('refunds:write')
  @ApiErrors(
    'REFUND_REQUEST_INVALID',
    'PAYMENT_NOT_FOUND',
    'PAYMENT_NOT_REFUNDABLE',
    'REFUND_AMOUNT_EXCEEDS_REMAINING'
  )
  @ApiEmits('refund.created', 'refund.succeeded', 'refund.failed', 'refund.cancelled')
  @ApiExample({
    request: {
      paymentId: 'pay_01JBX7Q2M4N8R5T6V9W0XYZABC',
      amountMinor: '10000',
      reason: 'Customer requested refund',
      metadata: { ticketId: 'T-123' },
    },
    response: {
      id: 'ref_01JBX7Q2M4N8R5T6V9W0XYZABC',
      ref: 'ref_01JBX7Q2M4N8R5T6V9W0XYZABC',
      transactionRef: 'txn_01JBX7Q2M4N8R5T6V9W0XYZABD',
      environment: 'test',
      paymentId: 'pay_01JBX7Q2M4N8R5T6V9W0XYZABC',
      paymentRef: 'pay_01JBX7Q2M4N8R5T6V9W0XYZABC',
      status: 'created',
      amountMinor: '10000',
      currency: 'UGX',
      reason: 'Customer requested refund',
      metadata: { ticketId: 'T-123' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
  })
  @Idempotent('refunds.create')
  @Audited('refund.created', 'refund')
  @ApiOperation({
    summary: 'Create a refund',
    description:
      'Requires an `Idempotency-Key`. Creates a refund for a succeeded payment. ' +
      'The refund amount cannot exceed the original payment amount minus any existing refunds.',
  })
  @ApiEnvelopedResponses({ 201: refundViewSchema })
  async create(
    @Body() body: CreateRefundDto,
    @CurrentApiKey() key: ApiKeyPrincipal,
    @IdempotencyKey() idempotency: IdempotencyContext
  ) {
    const scope = scopeOfApiKey(key);
    return this.refunds.create(
      scope,
      {
        paymentId: body.paymentId,
        amountMinor: BigInt(body.amountMinor),
        reason: body.reason,
        metadata: body.metadata,
      },
      idempotency
    );
  }

  @Get(':ref')
  @RequirePermission('refunds:read')
  @ApiErrors('NOT_FOUND')
  @ApiOperation({
    summary: 'Retrieve a refund',
    description: 'Get a single refund by its reference.',
  })
  @ApiEnvelopedResponses({ 200: refundViewSchema })
  async get(@Param() params: RefundParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    const scope = scopeOfApiKey(key);
    return this.refunds.get(scope, params.ref);
  }

  @Get()
  @RequirePermission('refunds:read')
  @ApiOperation({
    summary: 'List refunds',
    description:
      'List refunds with optional filtering by status, currency, payment reference, and date range.',
  })
  @ApiEnvelopedResponses({ 200: refundPageSchema })
  async list(@Query() query: ListRefundsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    const scope = scopeOfApiKey(key);
    return this.refunds.list(scope, {
      status: query.status,
      currency: query.currency,
      paymentRef: query.paymentRef,
      from: query.from,
      to: query.to,
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
