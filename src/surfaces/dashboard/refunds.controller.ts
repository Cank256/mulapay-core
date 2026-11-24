/**
 * `/dashboard/v1/refunds` (spec 7.2): the merchant's own refunds — list, detail, create.
 * The session is bound to one merchant; the environment is chosen per request.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { IdempotencyKey, Idempotent } from '../../common/idempotency/idempotent.decorator';
import type { IdempotencyContext } from '../../common/idempotency/idempotency.types';
import { MAX_PAGE_LIMIT, pageQuerySchema } from '../../common/pagination/cursor';
import { RefundsService } from '../../modules/refunds/refunds.service';
import { currencySchema, metadataSchema, refParamSchema } from '../shared/schemas';
import { amountMinorSchema, dateTimeSchema, environmentSchema } from '../shared/payment.schemas';

const refundStatusSchema = z.enum([
  'created',
  'pending_approval',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
]);

const createRefundSchema = z.strictObject({
  paymentRef: z.string().min(1).max(64),
  amountMinor: amountMinorSchema,
  reason: z.string().min(1).max(500).optional(),
  metadata: metadataSchema.optional(),
});

const listRefundsSchema = z.strictObject({
  status: refundStatusSchema.optional(),
  currency: currencySchema.optional(),
  paymentRef: z.string().min(1).max(64).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  environment: environmentSchema.default('live'),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
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
  status: refundStatusSchema,
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
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
class RefParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Refunds')
@Controller('refunds')
export class DashboardRefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('refunds:write')
  @Audited('refund.created', 'refund')
  @Idempotent('refunds.create')
  @ApiOperation({
    summary: 'Create a refund',
    description:
      'Requires an `Idempotency-Key`. `processing` means the gateway has been asked. The ledger ' +
      'posts the refund only when a later read shows `succeeded`.',
  })
  @ApiEnvelopedResponses({ 201: refundViewSchema })
  async create(
    @Body() body: CreateRefundDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal,
    @IdempotencyKey() idempotency: IdempotencyContext
  ) {
    const scope = scopeOfMerchantUser(user, 'live');
    const result = await this.refunds.create(
      scope,
      {
        paymentId: body.paymentRef,
        amountMinor: body.amountMinor,
        reason: body.reason,
        metadata: body.metadata,
      },
      idempotency
    );
    return result.body;
  }

  @Get(':ref')
  @RequirePermission('refunds:read')
  @ApiOperation({ summary: 'Retrieve a refund' })
  @ApiEnvelopedResponses({ 200: refundViewSchema })
  async get(
    @Param() params: RefParamDto,
    @Query('environment') env: 'test' | 'live',
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const scope = scopeOfMerchantUser(user, env ?? 'live');
    return this.refunds.get(scope, params.ref);
  }

  @Get()
  @RequirePermission('refunds:read')
  @ApiOperation({ summary: 'List refunds' })
  @ApiEnvelopedResponses({ 200: refundPageSchema })
  async list(@Query() query: ListRefundsDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...filters } = query;
    const scope = scopeOfMerchantUser(user, environment);
    return this.refunds.list(scope, {
      status: filters.status,
      currency: filters.currency,
      paymentRef: filters.paymentRef,
      from: filters.from,
      to: filters.to,
      limit: filters.limit,
      cursor: filters.cursor,
    });
  }
}
