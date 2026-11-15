/**
 * `/v1/balances`, `/v1/balance-transactions` and `/v1/holds` (spec 7.1). Read-only views of
 * the ledger-backed balance. Thin: scope from the API key, shape mapping here, everything
 * else in the services.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { BalancesService } from '../../modules/balances/balances.service';
import { merchantBalanceSchema, toMerchantBalanceView } from '../../modules/balances/balance.views';
import { holdSchema } from '../../modules/holds/hold.views';
import { HoldsService } from '../../modules/holds/holds.service';
import { LedgerQueryService } from '../../modules/ledger/ledger-query.service';
import {
  balanceTransactionPageSchema,
  toBalanceTransactionView,
} from '../shared/balance-transaction.schemas';
import { listBalanceTransactionsSchema, listHoldsSchema } from '../shared/developer.schemas';

class ListBalanceTransactionsDto extends createZodDto(listBalanceTransactionsSchema) {}
class ListHoldsDto extends createZodDto(listHoldsSchema) {}

@ApiTags('Balances')
@Controller('balances')
export class BalancesController {
  constructor(private readonly balances: BalancesService) {}

  @Get()
  @RequirePermission('balances:read')
  @ApiOperation({
    summary: 'Balances per currency',
    description:
      'One entry per currency the merchant holds. `postedMinor` is the ledger balance, ' +
      '`heldMinor` is reserved by active holds, `pendingMinor` is payments still processing ' +
      '(informational, never spendable), and `availableMinor = posted - held - reserved` is ' +
      'what payouts and refunds can draw on. A test key sees test balances only.',
  })
  @ApiEnvelopedResponses({ 200: z.array(merchantBalanceSchema) })
  async list(@CurrentApiKey() key: ApiKeyPrincipal) {
    const scope = scopeOfApiKey(key);
    const balances = await this.balances.merchantBalances(scope.merchantId, scope.environment);
    return balances.map((balance) => toMerchantBalanceView(scope.environment, balance));
  }
}

@ApiTags('Balances')
@Controller('balance-transactions')
export class BalanceTransactionsController {
  constructor(private readonly ledger: LedgerQueryService) {}

  @Get()
  @RequirePermission('balances:read')
  @ApiOperation({
    summary: 'Movements of the merchant balance, newest first',
    description:
      'Each ledger movement on the merchant balance: a collection credited, a payout debited, ' +
      'and so on. Cursor-paginated; the window defaults to the last 90 days.',
  })
  @ApiEnvelopedResponses({ 200: balanceTransactionPageSchema })
  async list(@Query() query: ListBalanceTransactionsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    const scope = scopeOfApiKey(key);
    const page = await this.ledger.merchantMovements(scope, query);
    return { items: page.items.map(toBalanceTransactionView), nextCursor: page.nextCursor };
  }
}

@ApiTags('Balances')
@Controller('holds')
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @Get()
  @RequirePermission('balances:read')
  @ApiOperation({
    summary: 'Holds against the available balance, newest first',
    description:
      'A hold reserves funds for an operation in flight. It ends once: captured, released or ' +
      'expired. Filter with `state`.',
  })
  @ApiEnvelopedResponses({
    200: z.object({ items: z.array(holdSchema), nextCursor: z.string().nullable() }),
  })
  list(@Query() query: ListHoldsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.holds.list(scopeOfApiKey(key), query);
  }
}
