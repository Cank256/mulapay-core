/**
 * `/dashboard/v1/balances` and `/holds` (spec 7.2): the merchant's own balances and holds.
 * Read-only views of financial state already owned by the ledger and holds services.
 * The session is bound to one merchant; the environment is chosen per request.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { BalancesService } from '../../modules/balances/balances.service';
import { HoldsService } from '../../modules/holds/holds.service';
import {
  holdSchema,
  merchantBalanceSchema,
  toHoldView,
  toMerchantBalanceView,
} from '../../modules/ledger/ledger.views';
import { environmentSchema } from '../shared/payment.schemas';

const balanceQuerySchema = z.strictObject({
  environment: environmentSchema.default('live'),
});

class BalanceQueryDto extends createZodDto(balanceQuerySchema) {}

@ApiTags('Balances')
@Controller()
export class DashboardBalancesController {
  constructor(
    private readonly balances: BalancesService,
    private readonly holds: HoldsService
  ) {}

  @Get('balances')
  @RequirePermission('balances:read')
  @ApiOperation({ summary: 'Merchant balances by currency' })
  @ApiEnvelopedResponses({ 200: z.array(merchantBalanceSchema) })
  async listBalances(
    @Query() q: BalanceQueryDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const result = await this.balances.merchantBalances(user.merchant.id, q.environment);
    return result.map(toMerchantBalanceView);
  }

  @Get('holds')
  @RequirePermission('holds:read')
  @ApiOperation({ summary: 'Active holds, newest first (up to 100)' })
  @ApiEnvelopedResponses({ 200: z.array(holdSchema) })
  async listHolds(
    @Query() q: BalanceQueryDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const result = await this.holds.listActive(user.merchant.id, q.environment, 100);
    return result.map(toHoldView);
  }
}
