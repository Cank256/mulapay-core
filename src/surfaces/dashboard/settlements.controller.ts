/**
 * `/dashboard/v1/settlements` (spec 7.2): the merchant's settlements, the itemised statement
 * and its CSV download. The session is bound to one merchant; only live money settles.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { MerchantSettlementsService } from '../../modules/settlement/merchant-settlements.service';
import {
  settlementItemPageSchema,
  settlementPageSchema,
  settlementSchema,
} from '../../modules/settlement/settlement.views';
import { refParamSchema } from '../shared/schemas';
import {
  csvDownloadSchema,
  listSettlementsSchema,
  settlementItemsQuerySchema,
  statementSchema,
} from '../shared/settlement.schemas';

class ListDto extends createZodDto(listSettlementsSchema) {}
class ItemsDto extends createZodDto(settlementItemsQuerySchema) {}
class RefDto extends createZodDto(refParamSchema) {}

@ApiTags('Settlements')
@Controller('settlements')
export class DashboardSettlementsController {
  constructor(private readonly settlements: MerchantSettlementsService) {}

  @Get()
  @RequirePermission('settlements:read')
  @ApiOperation({ summary: 'List the merchant’s settlements, newest first' })
  @ApiEnvelopedResponses({ 200: settlementPageSchema })
  list(@Query() query: ListDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.settlements.list(scopeOfMerchantUser(user, 'live'), query);
  }

  @Get(':ref')
  @RequirePermission('settlements:read')
  @ApiOperation({ summary: 'One settlement' })
  @ApiEnvelopedResponses({ 200: settlementSchema })
  get(@Param() p: RefDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.settlements.get(scopeOfMerchantUser(user, 'live'), p.ref);
  }

  @Get(':ref/items')
  @RequirePermission('settlements:read')
  @ApiOperation({ summary: 'The payments, refunds and reserve lines behind a settlement' })
  @ApiEnvelopedResponses({ 200: settlementItemPageSchema })
  items(
    @Param() p: RefDto,
    @Query() q: ItemsDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.settlements.items(scopeOfMerchantUser(user, 'live'), p.ref, q);
  }

  @Get(':ref/statement')
  @RequirePermission('settlements:read')
  @ApiOperation({
    summary: 'The itemised statement of a settlement',
    description:
      'Amounts, items, payout reference, masked destination and reconciliation references.',
  })
  @ApiEnvelopedResponses({ 200: statementSchema })
  statement(@Param() p: RefDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.settlements.statement(scopeOfMerchantUser(user, 'live'), p.ref);
  }

  @Get(':ref/statement/csv')
  @RequirePermission('settlements:read')
  @ApiOperation({ summary: 'The statement as CSV, ready to save as a file' })
  @ApiEnvelopedResponses({ 200: csvDownloadSchema })
  csv(@Param() p: RefDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.settlements.csv(scopeOfMerchantUser(user, 'live'), p.ref);
  }
}
