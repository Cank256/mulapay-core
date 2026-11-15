/**
 * `/v1/checkout-sessions` (spec 7.1). Thin: validate, authorize, map the shape. Starting a
 * session's payment is not a merchant-server call and has no route here yet.
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiErrors } from '../../common/openapi/api-docs.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { IdempotencyKey, Idempotent } from '../../common/idempotency/idempotent.decorator';
import type { IdempotencyContext } from '../../common/idempotency/idempotency.types';
import { CheckoutSessionsService } from '../../modules/payments/checkout-sessions.service';
import {
  checkoutSessionSchema,
  createdCheckoutSessionSchema,
} from '../../modules/payments/payment.views';
import { createCheckoutSessionSchema } from '../shared/payment.schemas';
import { refParamSchema } from '../shared/schemas';

class CreateCheckoutSessionDto extends createZodDto(createCheckoutSessionSchema) {}
class CheckoutSessionParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Checkout sessions')
@Controller('checkout-sessions')
export class CheckoutSessionsController {
  constructor(private readonly sessions: CheckoutSessionsService) {}

  @Post()
  @RequirePermission('payments:write')
  @ApiErrors('PAYMENT_REQUEST_INVALID', 'MERCHANT_NOT_ACTIVE')
  @Idempotent('checkout_sessions.create')
  @Audited('checkout_session.created', 'checkout_session')
  @ApiOperation({
    summary: 'Create a checkout session',
    description:
      'The response carries the `clientSecret` once. A replay of the same request returns ' +
      '`clientSecret: null`: the secret is never stored in clear.',
  })
  @ApiEnvelopedResponses({ 201: createdCheckoutSessionSchema })
  create(
    @Body() body: CreateCheckoutSessionDto,
    @CurrentApiKey() key: ApiKeyPrincipal,
    @IdempotencyKey() idempotency: IdempotencyContext
  ) {
    return this.sessions.create(scopeOfApiKey(key), body, idempotency);
  }

  @Get(':ref')
  @RequirePermission('payments:read')
  @ApiOperation({ summary: 'Retrieve a checkout session' })
  @ApiEnvelopedResponses({ 200: checkoutSessionSchema })
  get(@Param() params: CheckoutSessionParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.sessions.get(scopeOfApiKey(key), params.ref);
  }

  @Post(':ref/expire')
  @HttpCode(200)
  @RequirePermission('payments:write')
  @ApiErrors('CHECKOUT_SESSION_UNAVAILABLE')
  @Audited('checkout_session.expired', 'checkout_session')
  @ApiOperation({
    summary: 'Expire a checkout session',
    description:
      'Expires an open session and cancels its payment if that was never submitted to a provider. ' +
      'A completed session, or one whose payment is running, is a 409.',
  })
  @ApiEnvelopedResponses({ 200: checkoutSessionSchema })
  expire(@Param() params: CheckoutSessionParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.sessions.expire(scopeOfApiKey(key), params.ref);
  }
}
