/** Admin balance and hold reads (spec 7.3). Holds are placed and ended by the money flows. */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { BalancesService } from '../../modules/balances/balances.service';
import { HoldsService } from '../../modules/holds/holds.service';
import {
  holdSchema,
  merchantBalanceSchema,
  toHoldView,
  toMerchantBalanceView,
} from '../../modules/ledger/ledger.views';
import { MerchantsRepository } from '../../modules/merchants/merchants.repository';
import { refSchema } from '../shared/schemas';
class MerchantScopeDto extends createZodDto(
  z.strictObject({
    merchant: refSchema,
    environment: z.enum(['test', 'live']).default('live'),
  })
) {}
@ApiTags('Balances')
@Controller()
export class AdminBalancesController {
  constructor(
    private readonly balances: BalancesService,
    private readonly holds: HoldsService,
    private readonly merchants: MerchantsRepository
  ) {}
  @Get('balances')
  @RequirePermission('balances:read')
  @ApiOperation({ summary: 'Posted, held, pending, reserved and available balance per currency' })
  @ApiEnvelopedResponses({ 200: z.array(merchantBalanceSchema) })
  async balancesOf(@Query() q: MerchantScopeDto) {
    const merchant = await this.merchant(q.merchant);
    return (await this.balances.merchantBalances(merchant, q.environment)).map(
      toMerchantBalanceView
    );
  }
  @Get('holds')
  @RequirePermission('holds:read')
  @ApiOperation({ summary: 'Active holds of a merchant, newest first (up to 100)' })
  @ApiEnvelopedResponses({ 200: z.array(holdSchema) })
  async holdsOf(@Query() q: MerchantScopeDto) {
    const merchant = await this.merchant(q.merchant);
    return (await this.holds.listActive(merchant, q.environment, 100)).map(toHoldView);
  }
  private async merchant(ref: string): Promise<string> {
    const row = await this.merchants.findByRef(ref);
    if (!row) throw new AppError('NOT_FOUND');
    return row.id;
  }
}
