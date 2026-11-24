/**
 * `/admin/v1/payouts` — admin view and approval of merchant payouts.
 *
 * Finance staff can list payouts, view details, and approve or reject pending-approval
 * payouts. Approving a payout releases it for gateway submission; rejecting cancels it
 * and releases its hold back to the merchant's available balance.
 *
 * Thin controller: auth, validate, delegate to PayoutApprovalService / PayoutsRepository.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  decodeCursor,
  filterFingerprint,
  MAX_PAGE_LIMIT,
  pageQuerySchema,
  toPage,
} from '../../common/pagination/cursor';
import { MerchantsRepository } from '../../modules/merchants/merchants.repository';
import { PayoutApprovalService } from '../../modules/payouts/payout-approval.service';
import { PayoutsRepository } from '../../modules/payouts/payouts.repository';
import { toPayoutView } from '../../modules/payouts/payout.views';
import { currencySchema, refParamSchema } from '../shared/schemas';
import { dateTimeSchema } from '../shared/payment.schemas';

const payoutStatusSchema = z.enum([
  'created',
  'pending_approval',
  'processing',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
]);

const approveBodySchema = z.strictObject({
  note: z.string().max(500).optional(),
});

const rejectBodySchema = z.strictObject({
  note: z.string().max(500).optional(),
});

const listAdminPayoutsSchema = z.strictObject({
  status: payoutStatusSchema.optional(),
  currency: currencySchema.optional(),
  merchantRef: z.string().min(1).max(64).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
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

class ApproveBodyDto extends createZodDto(approveBodySchema) {}
class RejectBodyDto extends createZodDto(rejectBodySchema) {}
class ListAdminPayoutsDto extends createZodDto(listAdminPayoutsSchema) {}
class RefParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Admin Payouts')
@Controller('payouts')
export class AdminPayoutsController {
  constructor(
    private readonly approval: PayoutApprovalService,
    private readonly payoutsRepo: PayoutsRepository,
    private readonly merchants: MerchantsRepository
  ) {}

  @Get()
  @RequirePermission('payouts:read')
  @ApiOperation({ summary: 'List all payouts (admin)' })
  @ApiEnvelopedResponses({ 200: payoutPageSchema })
  async list(@Query() query: ListAdminPayoutsDto) {
    const fingerprint = filterFingerprint({
      status: query.status,
      currency: query.currency,
      merchantRef: query.merchantRef,
      from: query.from?.toISOString(),
      to: query.to?.toISOString(),
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const merchant = query.merchantRef
      ? await this.merchants.findByRef(query.merchantRef)
      : undefined;
    if (query.merchantRef && !merchant) {
      return {
        data: [],
        pagination: { limit: query.limit, cursor: null, hasMore: false },
      };
    }
    const rows = await this.payoutsRepo.listAdmin({
      status: query.status,
      currency: query.currency,
      merchantId: merchant?.id,
      from: query.from ?? new Date(0),
      to: query.to ?? new Date(),
      after,
      limit: query.limit + 1,
    });
    const page = toPage(rows, query.limit, fingerprint, (row) => ({
      createdAt: row.payout.createdAt,
      id: row.payout.ref,
    }));
    return {
      data: page.items.map((row) => toPayoutView(row)),
      pagination: {
        limit: query.limit,
        cursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    };
  }

  @Get(':ref')
  @RequirePermission('payouts:read')
  @ApiOperation({ summary: 'Retrieve a payout (admin)' })
  @ApiEnvelopedResponses({ 200: payoutViewSchema })
  async get(@Param() params: RefParamDto) {
    const detail = await this.payoutsRepo.findDetailByRefAdmin(params.ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toPayoutView(detail);
  }

  @Post(':ref/approve')
  @HttpCode(200)
  @RequirePermission('payouts:approve')
  @Audited('payout.approved', 'payout')
  @ApiOperation({
    summary: 'Approve a pending-approval payout',
    description:
      'Moves a `pending_approval` payout to `processing` and submits it to the gateway when ' +
      'the environment is live. `processing` is not settled. The ledger posts the disbursement ' +
      'only when a later read shows `succeeded`.',
  })
  @ApiEnvelopedResponses({ 200: payoutViewSchema })
  async approve(
    @Param() params: RefParamDto,
    @Body() body: ApproveBodyDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return this.approval.approve({
      payoutRef: params.ref,
      note: body.note,
      staffId: staff.userId,
      staffRef: staff.userRef,
    });
  }

  @Post(':ref/reject')
  @HttpCode(200)
  @RequirePermission('payouts:approve')
  @Audited('payout.rejected', 'payout')
  @ApiOperation({
    summary: 'Reject a pending-approval payout',
    description:
      'Cancels the payout and releases its hold back to the merchant available balance. ' +
      'Only valid for payouts in `pending_approval` status.',
  })
  @ApiEnvelopedResponses({ 200: payoutViewSchema })
  async reject(
    @Param() params: RefParamDto,
    @Body() body: RejectBodyDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return this.approval.reject({
      payoutRef: params.ref,
      note: body.note,
      staffId: staff.userId,
      staffRef: staff.userRef,
    });
  }
}
