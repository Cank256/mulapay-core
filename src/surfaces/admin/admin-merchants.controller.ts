/**
 * `/admin/v1/merchants` (spec 7.3). Lifecycle actions need step-up as well as the
 * `merchants:lifecycle` permission. Limits, fee plan, balances, activity and
 * impersonation arrive with the phases that own them.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { MAX_ADMIN_PAGE_LIMIT, pageQuerySchema } from '../../common/pagination/cursor';
import { MERCHANT_STATUSES } from '../../modules/merchants/domain/merchant-lifecycle';
import {
  createdInvitationSchema,
  memberSchema,
  merchantSchema,
} from '../../modules/merchants/merchant.views';
import { MerchantsService } from '../../modules/merchants/merchants.service';
import { TeamService } from '../../modules/merchants/team.service';
import {
  countrySchema,
  currencySchema,
  emailSchema,
  mccSchema,
  metadataSchema,
  nameSchema,
  refParamSchema,
  websiteSchema,
} from '../shared/schemas';

class CreateMerchantDto extends createZodDto(
  z.strictObject({
    legalName: nameSchema,
    tradingName: nameSchema.optional(),
    country: countrySchema,
    defaultCurrency: currencySchema,
    mcc: mccSchema.optional(),
    website: websiteSchema.optional(),
    supportEmail: emailSchema.optional(),
    metadata: metadataSchema.optional(),
    ownerEmail: emailSchema.optional(),
  })
) {}

class UpdateMerchantDto extends createZodDto(
  z.strictObject({
    legalName: nameSchema.optional(),
    tradingName: nameSchema.nullable().optional(),
    country: countrySchema.optional(),
    defaultCurrency: currencySchema.optional(),
    riskRating: z.enum(['low', 'medium', 'high']).nullable().optional(),
    mcc: mccSchema.nullable().optional(),
    website: websiteSchema.nullable().optional(),
    supportEmail: emailSchema.nullable().optional(),
    metadata: metadataSchema.optional(),
  })
) {}

class LifecycleDto extends createZodDto(
  z.strictObject({ reason: z.string().trim().min(1).max(500) })
) {}
class MerchantParamDto extends createZodDto(refParamSchema) {}
class ListMerchantsQueryDto extends createZodDto(
  z.strictObject({
    status: z.enum(MERCHANT_STATUSES).optional(),
    ...pageQuerySchema(MAX_ADMIN_PAGE_LIMIT),
  })
) {}

const createdMerchantSchema = z.object({
  merchant: merchantSchema,
  ownerInvitation: createdInvitationSchema.nullable(),
});
const merchantPageSchema = z.object({
  items: z.array(merchantSchema),
  nextCursor: z.string().nullable(),
});

@ApiTags('Merchants')
@Controller('merchants')
export class AdminMerchantsController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly team: TeamService
  ) {}

  @Get()
  @RequirePermission('merchants:read')
  @ApiOperation({ summary: 'List merchants, newest first' })
  @ApiEnvelopedResponses({ 200: merchantPageSchema })
  list(@Query() query: ListMerchantsQueryDto) {
    return this.merchants.list(query);
  }

  @Post()
  @RequirePermission('merchants:create')
  @Audited('merchant.created', 'merchant')
  @ApiOperation({ summary: 'Create a draft merchant, optionally inviting its owner' })
  @ApiEnvelopedResponses({ 201: createdMerchantSchema })
  create(@Body() body: CreateMerchantDto, @CurrentStaff() principal: StaffPrincipal) {
    return this.merchants.create(body, { userId: principal.userId });
  }

  @Get(':ref')
  @RequirePermission('merchants:read')
  @ApiOperation({ summary: 'One merchant' })
  @ApiEnvelopedResponses({ 200: merchantSchema })
  get(@Param() params: MerchantParamDto) {
    return this.merchants.getByRef(params.ref);
  }

  @Patch(':ref')
  @RequirePermission('merchants:update')
  @Audited('merchant.updated', 'merchant')
  @ApiOperation({ summary: 'Edit a merchant profile' })
  @ApiEnvelopedResponses({ 200: merchantSchema })
  update(@Param() params: MerchantParamDto, @Body() body: UpdateMerchantDto) {
    return this.merchants.update({ ref: params.ref }, body);
  }

  @Post(':ref/activate')
  @HttpCode(200)
  @RequirePermission('merchants:lifecycle')
  @RequiresStepUp()
  @Audited('merchant.activated', 'merchant')
  @ApiOperation({ summary: 'Reinstate a suspended merchant' })
  @ApiEnvelopedResponses({ 200: merchantSchema })
  activate(@Param() params: MerchantParamDto, @Body() body: LifecycleDto) {
    return this.merchants.transition(params.ref, 'activate', body.reason);
  }

  @Post(':ref/suspend')
  @HttpCode(200)
  @RequirePermission('merchants:lifecycle')
  @RequiresStepUp()
  @Audited('merchant.suspended', 'merchant')
  @ApiOperation({ summary: 'Suspend an active merchant' })
  @ApiEnvelopedResponses({ 200: merchantSchema })
  suspend(@Param() params: MerchantParamDto, @Body() body: LifecycleDto) {
    return this.merchants.transition(params.ref, 'suspend', body.reason);
  }

  @Post(':ref/close')
  @HttpCode(200)
  @RequirePermission('merchants:lifecycle')
  @RequiresStepUp()
  @Audited('merchant.closed', 'merchant')
  @ApiOperation({ summary: 'Close a merchant. Needs a zero balance; closing is final' })
  @ApiEnvelopedResponses({ 200: merchantSchema })
  close(@Param() params: MerchantParamDto, @Body() body: LifecycleDto) {
    return this.merchants.transition(params.ref, 'close', body.reason);
  }

  @Get(':ref/users')
  @RequirePermission('merchants:read')
  @ApiOperation({ summary: 'Team members of a merchant' })
  @ApiEnvelopedResponses({ 200: z.array(memberSchema) })
  users(@Param() params: MerchantParamDto) {
    return this.team.listByMerchantRef(params.ref);
  }
}
