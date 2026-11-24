/**
 * `/admin/v1/refunds` — admin read-only view of all merchant refunds.
 * Admins can list and inspect refunds across all merchants for support and investigation.
 * Refund creation stays on the merchant surface (dashboard or public API).
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { MAX_PAGE_LIMIT, pageQuerySchema } from '../../common/pagination/cursor';
import { RefundsRepository } from '../../modules/refunds/refunds.repository';
import { toRefundView } from '../../modules/refunds/refund.views';
import { MerchantsRepository } from '../../modules/merchants/merchants.repository';
import { currencySchema, refParamSchema } from '../shared/schemas';
import { dateTimeSchema } from '../shared/payment.schemas';

const refundStatusSchema = z.enum([
  'created',
  'pending_approval',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
]);

const listAdminRefundsSchema = z.strictObject({
  status: refundStatusSchema.optional(),
  currency: currencySchema.optional(),
  merchantRef: z.string().min(1).max(64).optional(),
  paymentRef: z.string().min(1).max(64).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
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

class ListAdminRefundsDto extends createZodDto(listAdminRefundsSchema) {}
class RefParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Admin Refunds')
@Controller('refunds')
export class AdminRefundsController {
  constructor(
    private readonly refunds: RefundsRepository,
    private readonly merchants: MerchantsRepository
  ) {}

  @Get()
  @RequirePermission('refunds:read')
  @ApiOperation({ summary: 'List all refunds (admin)' })
  @ApiEnvelopedResponses({ 200: refundPageSchema })
  async list(@Query() query: ListAdminRefundsDto) {
    // Admin lists are not merchant-scoped; we pass a scope that matches nothing
    // and rely on the repository returning all refunds. The repository's list
    // method takes a scope, but for admin we need a different approach.
    // Since the repository is merchant-scoped, we return all refunds by querying
    // without a specific merchant filter.
    const rows = await this.refunds.listAdmin({
      status: query.status,
      currency: query.currency,
      paymentRef: query.paymentRef,
      from: query.from ?? new Date(0),
      to: query.to ?? new Date(),
      limit: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((r) => toRefundView(r)),
      pagination: { limit: query.limit, cursor: null, hasMore },
    };
  }

  @Get(':ref')
  @RequirePermission('refunds:read')
  @ApiOperation({ summary: 'Retrieve a refund (admin)' })
  @ApiEnvelopedResponses({ 200: refundViewSchema })
  async get(@Param() params: RefParamDto) {
    const detail = await this.refunds.findDetailByRefAdmin(params.ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toRefundView(detail);
  }
}
