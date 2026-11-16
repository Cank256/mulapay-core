/** `GET /v1/settlements` (spec 7.1): the merchant's settlements. Read-only; live money only. */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { MerchantSettlementsService } from '../../modules/settlement/merchant-settlements.service';
import {
  settlementItemPageSchema,
  settlementPageSchema,
  settlementSchema,
} from '../../modules/settlement/settlement.views';
import { refParamSchema } from '../shared/schemas';
import { listSettlementsSchema, settlementItemsQuerySchema } from '../shared/settlement.schemas';

class ListDto extends createZodDto(listSettlementsSchema) {}
class ItemsDto extends createZodDto(settlementItemsQuerySchema) {}
class RefDto extends createZodDto(refParamSchema) {}

@ApiTags('Settlements')
@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlements: MerchantSettlementsService) {}

  @Get()
  @RequirePermission('settlements:read')
  @ApiOperation({ summary: 'List settlements, newest first. A test key sees none' })
  @ApiEnvelopedResponses({ 200: settlementPageSchema })
  list(@Query() query: ListDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.settlements.list(scopeOfApiKey(key), query);
  }

  @Get(':ref')
  @RequirePermission('settlements:read')
  @ApiOperation({ summary: 'Retrieve a settlement' })
  @ApiEnvelopedResponses({ 200: settlementSchema })
  get(@Param() p: RefDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.settlements.get(scopeOfApiKey(key), p.ref);
  }

  @Get(':ref/items')
  @RequirePermission('settlements:read')
  @ApiOperation({ summary: 'The payments, refunds and reserve lines behind a settlement' })
  @ApiEnvelopedResponses({ 200: settlementItemPageSchema })
  items(@Param() p: RefDto, @Query() q: ItemsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.settlements.items(scopeOfApiKey(key), p.ref, q);
  }
}
