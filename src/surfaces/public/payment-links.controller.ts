/** `/v1/payment-links` (spec 7.1). Thin: validate, authorize, map the shape. */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { IdempotencyKey, Idempotent } from '../../common/idempotency/idempotent.decorator';
import type { IdempotencyContext } from '../../common/idempotency/idempotency.types';
import { PaymentLinksService } from '../../modules/payments/payment-links.service';
import { paymentLinkPageSchema, paymentLinkSchema } from '../../modules/payments/payment.views';
import {
  createPaymentLinkSchema,
  listPaymentLinksSchema,
  updatePaymentLinkSchema,
} from '../shared/payment.schemas';
import { refParamSchema } from '../shared/schemas';

class CreatePaymentLinkDto extends createZodDto(createPaymentLinkSchema) {}
class UpdatePaymentLinkDto extends createZodDto(updatePaymentLinkSchema) {}
class ListPaymentLinksDto extends createZodDto(listPaymentLinksSchema) {}
class PaymentLinkParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Payment links')
@Controller('payment-links')
export class PaymentLinksController {
  constructor(private readonly links: PaymentLinksService) {}

  @Post()
  @RequirePermission('payments:write')
  @Idempotent('payment_links.create')
  @Audited('payment_link.created', 'payment_link')
  @ApiOperation({ summary: 'Create a payment link. Omit the amount for an open-amount link' })
  @ApiEnvelopedResponses({ 201: paymentLinkSchema })
  create(
    @Body() body: CreatePaymentLinkDto,
    @CurrentApiKey() key: ApiKeyPrincipal,
    @IdempotencyKey() idempotency: IdempotencyContext
  ) {
    return this.links.create(scopeOfApiKey(key), body, idempotency);
  }

  @Get()
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'List payment links, newest first' })
  @ApiEnvelopedResponses({ 200: paymentLinkPageSchema })
  list(@Query() query: ListPaymentLinksDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.links.list(scopeOfApiKey(key), query);
  }

  @Get(':ref')
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'Retrieve a payment link' })
  @ApiEnvelopedResponses({ 200: paymentLinkSchema })
  get(@Param() params: PaymentLinkParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.links.get(scopeOfApiKey(key), params.ref);
  }

  @Patch(':ref')
  @RequirePermission('payments:write')
  @Audited('payment_link.updated', 'payment_link')
  @ApiOperation({
    summary: 'Update a payment link',
    description: 'The amount and currency of a link never change; create a new link instead.',
  })
  @ApiEnvelopedResponses({ 200: paymentLinkSchema })
  update(
    @Param() params: PaymentLinkParamDto,
    @Body() body: UpdatePaymentLinkDto,
    @CurrentApiKey() key: ApiKeyPrincipal
  ) {
    return this.links.update(scopeOfApiKey(key), params.ref, body);
  }

  @Post(':ref/deactivate')
  @HttpCode(200)
  @RequirePermission('payments:write')
  @Audited('payment_link.deactivated', 'payment_link')
  @ApiOperation({ summary: 'Stop a payment link taking new payments' })
  @ApiEnvelopedResponses({ 200: paymentLinkSchema })
  deactivate(@Param() params: PaymentLinkParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.links.deactivate(scopeOfApiKey(key), params.ref);
  }
}
