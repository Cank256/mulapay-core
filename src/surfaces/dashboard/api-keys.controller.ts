/** `/dashboard/v1/api-keys` (spec 7.2): issue, roll and revoke the merchant's API keys. */
import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { API_KEY_SCOPES } from '../../common/authz/permissions';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { apiKeySchema, createdApiKeySchema } from '../../modules/api-keys/api-key.views';
import { ApiKeysService, MAX_ROLL_GRACE_HOURS } from '../../modules/api-keys/api-keys.service';
import { okSchema } from '../shared/auth.views';
import { cidrSchema, idParamSchema, nameSchema } from '../shared/schemas';

class CreateApiKeyDto extends createZodDto(
  z.strictObject({
    /** Only `secret` until P5-K4 decides what a publishable key may do. */
    type: z.literal('secret').default('secret'),
    name: nameSchema.max(100),
    environment: z.enum(['test', 'live']),
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
    ipAllowlist: z.array(cidrSchema).max(50).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    rateLimitRpm: z.number().int().min(1).max(100_000).optional(),
    signingRequired: z.boolean().optional(),
  })
) {}

class RollApiKeyDto extends createZodDto(
  z.strictObject({
    gracePeriodHours: z.number().int().min(0).max(MAX_ROLL_GRACE_HOURS).default(24),
  })
) {}

class ApiKeyParamDto extends createZodDto(idParamSchema) {}

@ApiTags('API keys')
@Controller('api-keys')
export class DashboardApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermission('api_keys:read')
  @ApiOperation({ summary: 'API keys of the merchant. Secrets are never returned' })
  @ApiEnvelopedResponses({ 200: z.array(apiKeySchema) })
  list(@CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return this.keys.list(principal.merchant.id);
  }

  @Post()
  @RequirePermission('api_keys:manage')
  @Audited('api_key.created', 'api_key')
  @ApiOperation({ summary: 'Create a key. The full key is in this response only' })
  @ApiEnvelopedResponses({ 201: createdApiKeySchema })
  create(@Body() body: CreateApiKeyDto, @CurrentMerchantUser() principal: MerchantUserPrincipal) {
    const { expiresAt, ...rest } = body;
    return this.keys.create(
      principal.merchant.id,
      { ...rest, expiresAt: expiresAt ? new Date(expiresAt) : undefined },
      { userId: principal.userId }
    );
  }

  @Post(':id/roll')
  @RequirePermission('api_keys:manage')
  @Audited('api_key.rolled', 'api_key')
  @ApiOperation({ summary: 'Replace a key; the old key stops working after the grace period' })
  @ApiEnvelopedResponses({ 201: createdApiKeySchema })
  roll(
    @Param() params: ApiKeyParamDto,
    @Body() body: RollApiKeyDto,
    @CurrentMerchantUser() principal: MerchantUserPrincipal
  ) {
    return this.keys.roll(principal.merchant.id, params.id, body.gracePeriodHours, {
      userId: principal.userId,
    });
  }

  @Delete(':id')
  @RequirePermission('api_keys:manage')
  @Audited('api_key.revoked', 'api_key')
  @ApiOperation({ summary: 'Revoke a key immediately' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async revoke(
    @Param() params: ApiKeyParamDto,
    @CurrentMerchantUser() principal: MerchantUserPrincipal
  ) {
    await this.keys.revoke(principal.merchant.id, params.id, { userId: principal.userId });
    return { ok: true as const };
  }
}
