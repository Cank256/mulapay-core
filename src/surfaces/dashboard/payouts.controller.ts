/**
 * `/merchant/v1/payouts` (spec 7.2): the merchant's own payouts — list, detail, create.
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
import { PayoutsService } from '../../modules/payouts/payouts.service';
import { currencySchema, metadataSchema, refParamSchema } from '../shared/schemas';
import { amountMinorSchema, dateTimeSchema, environmentSchema } from '../shared/payment.schemas';

const payoutStatusSchema = z.enum([
  'created',
  'pending_approval',
  'processing',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
]);

const destinationSchema = z.object({
  type: z.enum(['msisdn', 'bank_account']),
  value: z.string().min(1).max(100),
  name: z.string().min(1).max(100).optional(),
});

const createPayoutSchema = z.strictObject({
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  channel: z.enum(['mobile_money', 'bank']),
  destination: destinationSchema,
  description: z.string().min(1).max(500).optional(),
  metadata: metadataSchema.optional(),
  environment: environmentSchema.default('live'),
});

const listPayoutsSchema = z.strictObject({
  status: payoutStatusSchema.optional(),
  currency: currencySchema.optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  environment: environmentSchema.default('live'),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
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
  status: payoutStatusSchema,
  description: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
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
class RefParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Payouts')
@Controller('payouts')
export class DashboardPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('payouts:write')
  @Audited('payout.created', 'payout')
  @Idempotent('payouts.create')
  @ApiOperation({
    summary: 'Create a payout',
    description:
      'Requires an `Idempotency-Key`. Repeating the same key returns the first payout. ' +
      '`processing` means the gateway has been asked. The ledger posts the disbursement only ' +
      'when a later read shows `succeeded`. `pending_approval` waits for a staff decision.',
  })
  @ApiEnvelopedResponses({ 201: payoutViewSchema })
  async create(
    @Body() body: CreatePayoutDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal,
    @IdempotencyKey() idempotency: IdempotencyContext
  ) {
    const scope = scopeOfMerchantUser(user, body.environment);
    return this.payouts.create(
      scope,
      {
        amountMinor: body.amountMinor,
        currency: body.currency,
        channel: body.channel,
        destination: body.destination,
        description: body.description,
        metadata: body.metadata,
      },
      idempotency
    );
  }

  @Get(':ref')
  @RequirePermission('payouts:read')
  @ApiOperation({ summary: 'Retrieve a payout' })
  @ApiEnvelopedResponses({ 200: payoutViewSchema })
  async get(
    @Param() params: RefParamDto,
    @Query('environment') env: 'test' | 'live',
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const scope = scopeOfMerchantUser(user, env ?? 'live');
    return this.payouts.get(scope, params.ref);
  }

  @Get()
  @RequirePermission('payouts:read')
  @ApiOperation({ summary: 'List payouts' })
  @ApiEnvelopedResponses({ 200: payoutPageSchema })
  async list(@Query() query: ListPayoutsDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...filters } = query;
    const scope = scopeOfMerchantUser(user, environment);
    return this.payouts.list(scope, {
      status: filters.status,
      currency: filters.currency,
      from: filters.from,
      to: filters.to,
      limit: filters.limit,
      cursor: filters.cursor,
    });
  }
}
