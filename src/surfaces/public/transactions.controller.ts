/** `GET /v1/transactions` (spec 7.1): one read model over every money movement. */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  transactionDetailSchema,
  transactionPageSchema,
} from '../../modules/transactions/transaction.views';
import { TransactionsService } from '../../modules/transactions/transactions.service';
import { listTransactionsSchema } from '../shared/payment.schemas';
import { refParamSchema } from '../shared/schemas';

class ListTransactionsDto extends createZodDto(listTransactionsSchema) {}
class TransactionParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  @RequirePermission('transactions:read')
  @ApiOperation({
    summary: 'List transactions, newest first',
    description:
      'Cursor-paginated. Defaults to the last 90 days; a window is at most 366 days. ' +
      '`reference` matches the transaction id, its external id or the provider transaction id exactly.',
  })
  @ApiEnvelopedResponses({ 200: transactionPageSchema })
  list(@Query() query: ListTransactionsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.transactions.list(scopeOfApiKey(key), query);
  }

  @Get(':ref')
  @RequirePermission('transactions:read')
  @ApiOperation({ summary: 'Retrieve a transaction with its status timeline' })
  @ApiEnvelopedResponses({ 200: transactionDetailSchema })
  get(@Param() params: TransactionParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.transactions.get(scopeOfApiKey(key), params.ref);
  }
}
