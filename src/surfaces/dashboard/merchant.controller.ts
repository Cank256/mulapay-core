/**
 * `/merchant/v1/merchant` (spec 7.2). The merchant is always the caller's own, taken
 * from the session; no route accepts a merchant id. Settings, limits and fee plan views
 * arrive with the modules that own them (Phases 4 and 6).
 */
import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { merchantSchema } from '../../modules/merchants/merchant.views';
import { MerchantsService } from '../../modules/merchants/merchants.service';
import { emailSchema, nameSchema, websiteSchema } from '../shared/schemas';

/** Merchants edit their public-facing details; legal identity changes go through admins. */
class UpdateMerchantDto extends createZodDto(
  z.strictObject({
    tradingName: nameSchema.nullable().optional(),
    website: websiteSchema.nullable().optional(),
    supportEmail: emailSchema.nullable().optional(),
  })
) {}

@ApiTags('Merchant')
@Controller('merchant')
export class DashboardMerchantController {
  constructor(private readonly merchants: MerchantsService) {}

  @Get()
  @RequirePermission('merchant:read')
  @ApiOperation({ summary: 'The current merchant' })
  @ApiEnvelopedResponses({ 200: merchantSchema })
  get(@CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return this.merchants.getById(principal.merchant.id);
  }

  @Patch()
  @RequirePermission('merchant:update')
  @Audited('merchant.updated', 'merchant')
  @ApiOperation({ summary: 'Edit trading name, website and support email' })
  @ApiEnvelopedResponses({ 200: merchantSchema })
  update(@Body() body: UpdateMerchantDto, @CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return this.merchants.update({ id: principal.merchant.id }, body);
  }
}
