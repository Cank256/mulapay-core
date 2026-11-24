/**
 * `GET /dashboard/v1/payments` and `/transactions` (spec 7.2): the merchant's own lists. The
 * session is bound to one merchant; the environment is chosen per request (default `live`).
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { PaymentsService } from '../../modules/payments/payments.service';
import { paymentPageSchema, paymentSchema } from '../../modules/payments/payment.views';
import {
  timelineEntrySchema,
  transactionPageSchema,
} from '../../modules/transactions/transaction.views';
import { TransactionsService } from '../../modules/transactions/transactions.service';
import {
  environmentSchema,
  listDashboardPaymentsSchema,
  listDashboardTransactionsSchema,
} from '../shared/payment.schemas';
import { refParamSchema } from '../shared/schemas';

class ListDashboardPaymentsDto extends createZodDto(listDashboardPaymentsSchema) {}
class ListDashboardTransactionsDto extends createZodDto(listDashboardTransactionsSchema) {}
class PaymentParamDto extends createZodDto(refParamSchema) {}
class PaymentQueryDto extends createZodDto(
  z.strictObject({ environment: environmentSchema.default('live') })
) {}

@ApiTags('Payments')
@Controller('payments')
export class DashboardPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'List the merchant’s payments, newest first' })
  @ApiEnvelopedResponses({ 200: paymentPageSchema })
  list(
    @Query() query: ListDashboardPaymentsDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const { environment, ...filters } = query;
    return this.payments.list(scopeOfMerchantUser(user, environment), filters);
  }

  @Get(':ref')
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'Retrieve one of the merchant’s payments' })
  @ApiEnvelopedResponses({ 200: paymentSchema })
  get(
    @Param() params: PaymentParamDto,
    @Query() query: PaymentQueryDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.payments.get(scopeOfMerchantUser(user, query.environment), params.ref);
  }

  @Get(':ref/timeline')
  @RequirePermission('payments:read')
  @ApiOperation({
    summary: 'The statuses a payment went through, oldest first',
    description:
      'A payment is settled only when its status is `succeeded`. Earlier statuses, including ' +
      '`processing`, mean the ledger has not yet posted that collection.',
  })
  @ApiEnvelopedResponses({ 200: z.array(timelineEntrySchema) })
  timeline(
    @Param() params: PaymentParamDto,
    @Query() query: PaymentQueryDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.payments.timeline(scopeOfMerchantUser(user, query.environment), params.ref);
  }
}

@ApiTags('Transactions')
@Controller('transactions')
export class DashboardTransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Get()
  @RequirePermission('transactions:read')
  @ApiOperation({ summary: 'List the merchant’s transactions, newest first' })
  @ApiEnvelopedResponses({ 200: transactionPageSchema })
  list(
    @Query() query: ListDashboardTransactionsDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const { environment, ...filters } = query;
    return this.transactions.list(scopeOfMerchantUser(user, environment), filters);
  }
}
