/**
 * `/v1/payments` (spec 7.1). Thin: validate, authorize, map the shape. The scope (merchant and
 * environment) comes from the API key, never from the request.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEmits, ApiErrors, ApiExample } from '../../common/openapi/api-docs.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { IdempotencyKey, Idempotent } from '../../common/idempotency/idempotent.decorator';
import type { IdempotencyContext } from '../../common/idempotency/idempotency.types';
import { PaymentsService } from '../../modules/payments/payments.service';
import { paymentPageSchema, paymentSchema } from '../../modules/payments/payment.views';
import { timelineEntrySchema } from '../../modules/transactions/transaction.views';
import { createPaymentSchema, listPaymentsSchema } from '../shared/payment.schemas';
import { refParamSchema } from '../shared/schemas';

class CreatePaymentDto extends createZodDto(createPaymentSchema) {}
class ListPaymentsDto extends createZodDto(listPaymentsSchema) {}
class PaymentParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @RequirePermission('payments:write')
  @ApiErrors('PAYMENT_REQUEST_INVALID', 'MERCHANT_NOT_ACTIVE')
  @ApiEmits('payment.created', 'payment.succeeded', 'payment.failed', 'payment.expired')
  @ApiExample({
    request: {
      amountMinor: '10000',
      currency: 'UGX',
      channel: 'mobile_money',
      paymentMethod: { msisdn: '+256700000001' },
      description: 'Order 1042',
      metadata: { orderId: '1042' },
    },
    response: {
      id: 'pay_01JBX7Q2M4N8R5T6V9W0XYZABC',
      transactionId: 'txn_01JBX7Q2M4N8R5T6V9W0XYZABD',
      environment: 'test',
      status: 'created',
      amountMinor: '10000',
      currency: 'UGX',
      channel: 'mobile_money',
      provider: null,
      paymentMethod: { provider: null, msisdnLast4: '0001' },
      description: 'Order 1042',
      statementDescriptor: null,
      returnUrl: null,
      paymentLinkId: null,
      checkoutSessionId: null,
      failureCode: null,
      expiresAt: '2025-01-01T00:15:00.000Z',
      completedAt: null,
      metadata: { orderId: '1042' },
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  })
  @Idempotent('payments.create')
  @Audited('payment.created', 'payment')
  @ApiOperation({
    summary: 'Create a payment',
    description:
      'Requires an `Idempotency-Key`. The payment is created in `created`; a terminal state is ' +
      'only ever set by the gateway event consumer or the chase job, never by this request.',
  })
  @ApiEnvelopedResponses({ 201: paymentSchema })
  create(
    @Body() body: CreatePaymentDto,
    @CurrentApiKey() key: ApiKeyPrincipal,
    @IdempotencyKey() idempotency: IdempotencyContext
  ) {
    return this.payments.create(scopeOfApiKey(key), body, idempotency);
  }

  @Get()
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'List payments, newest first' })
  @ApiEnvelopedResponses({ 200: paymentPageSchema })
  list(@Query() query: ListPaymentsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.payments.list(scopeOfApiKey(key), query);
  }

  @Get(':ref')
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'Retrieve a payment' })
  @ApiEnvelopedResponses({ 200: paymentSchema })
  get(@Param() params: PaymentParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.payments.get(scopeOfApiKey(key), params.ref);
  }

  @Post(':ref/cancel')
  @HttpCode(200)
  @RequirePermission('payments:write')
  @ApiErrors('PAYMENT_INVALID_TRANSITION')
  @ApiEmits('payment.cancelled')
  @Audited('payment.cancelled', 'payment')
  @ApiOperation({
    summary: 'Cancel a payment',
    description:
      'Allowed while the payment is `created` or `requires_action`. A payment that is already ' +
      'cancelled is returned unchanged; any other state is a 409.',
  })
  @ApiEnvelopedResponses({ 200: paymentSchema })
  cancel(@Param() params: PaymentParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.payments.cancel(scopeOfApiKey(key), params.ref);
  }

  @Get(':ref/timeline')
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'The statuses a payment went through, oldest first' })
  @ApiEnvelopedResponses({ 200: z.array(timelineEntrySchema) })
  timeline(@Param() params: PaymentParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.payments.timeline(scopeOfApiKey(key), params.ref);
  }
}
