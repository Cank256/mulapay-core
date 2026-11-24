/**
 * `/merchant/v1/webhook-endpoints` and `/webhook-deliveries` (spec 7.2): the dashboard's view
 * of webhooks. Endpoint routes mirror `/v1/webhook-endpoints`; the delivery routes list the
 * delivery log and replay deliveries individually or in bulk. The session is bound to one
 * merchant; the environment is chosen per request (default `live`).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  replayResultSchema,
  webhookDeliveryPageSchema,
  webhookDeliverySchema,
} from '../../modules/webhooks/webhook-delivery.views';
import { WebhookDeliveriesService } from '../../modules/webhooks/webhook-deliveries.service';
import {
  createdWebhookEndpointSchema,
  webhookEndpointSchema,
} from '../../modules/webhooks/webhook-endpoint.views';
import { WebhookEndpointsService } from '../../modules/webhooks/webhook-endpoints.service';
import { okSchema } from '../shared/auth.views';
import {
  createWebhookEndpointSchema,
  environmentQuerySchema,
  listWebhookDeliveriesSchema,
  replayDeliveriesSchema,
  rotateSecretSchema,
  updateWebhookEndpointSchema,
} from '../shared/developer.schemas';
import { idParamSchema } from '../shared/schemas';

class EnvironmentDto extends createZodDto(environmentQuerySchema) {}
class CreateEndpointDto extends createZodDto(createWebhookEndpointSchema) {}
class UpdateEndpointDto extends createZodDto(updateWebhookEndpointSchema) {}
class RotateSecretDto extends createZodDto(rotateSecretSchema) {}
class IdParamDto extends createZodDto(idParamSchema) {}
class ListDeliveriesDto extends createZodDto(listWebhookDeliveriesSchema) {}
class ReplayDeliveriesDto extends createZodDto(replayDeliveriesSchema) {}

@ApiTags('Webhook endpoints')
@Controller('webhook-endpoints')
export class DashboardWebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointsService) {}

  @Get()
  @RequirePermission('webhooks:read')
  @ApiOperation({ summary: 'List webhook endpoints' })
  @ApiEnvelopedResponses({ 200: z.array(webhookEndpointSchema) })
  list(@Query() query: EnvironmentDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.endpoints.list(scopeOfMerchantUser(user, query.environment));
  }

  @Post()
  @RequirePermission('webhooks:manage')
  @Audited('webhook_endpoint.created', 'webhook_endpoint')
  @ApiOperation({ summary: 'Register a webhook endpoint. The secret is in this response only' })
  @ApiEnvelopedResponses({ 201: createdWebhookEndpointSchema })
  create(
    @Query() query: EnvironmentDto,
    @Body() body: CreateEndpointDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.endpoints.create(scopeOfMerchantUser(user, query.environment), body);
  }

  @Get(':id')
  @RequirePermission('webhooks:read')
  @ApiOperation({ summary: 'Retrieve a webhook endpoint' })
  @ApiEnvelopedResponses({ 200: webhookEndpointSchema })
  get(
    @Param() params: IdParamDto,
    @Query() query: EnvironmentDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.endpoints.get(scopeOfMerchantUser(user, query.environment), params.id);
  }

  @Patch(':id')
  @RequirePermission('webhooks:manage')
  @Audited('webhook_endpoint.updated', 'webhook_endpoint')
  @ApiOperation({ summary: 'Change, pause or re-enable a webhook endpoint' })
  @ApiEnvelopedResponses({ 200: webhookEndpointSchema })
  update(
    @Param() params: IdParamDto,
    @Query() query: EnvironmentDto,
    @Body() body: UpdateEndpointDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.endpoints.update(scopeOfMerchantUser(user, query.environment), params.id, body);
  }

  @Delete(':id')
  @RequirePermission('webhooks:manage')
  @Audited('webhook_endpoint.deleted', 'webhook_endpoint')
  @ApiOperation({ summary: 'Delete a webhook endpoint (history is kept)' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async remove(
    @Param() params: IdParamDto,
    @Query() query: EnvironmentDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    await this.endpoints.delete(scopeOfMerchantUser(user, query.environment), params.id);
    return { ok: true as const };
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RequirePermission('webhooks:manage')
  @Audited('webhook_endpoint.secret_rotated', 'webhook_endpoint')
  @ApiOperation({ summary: 'Rotate the signing secret. The new secret is in this response only' })
  @ApiEnvelopedResponses({ 200: createdWebhookEndpointSchema })
  rotate(
    @Param() params: IdParamDto,
    @Query() query: EnvironmentDto,
    @Body() body: RotateSecretDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.endpoints.rotateSecret(
      scopeOfMerchantUser(user, query.environment),
      params.id,
      body.graceHours
    );
  }
}

@ApiTags('Webhook deliveries')
@Controller('webhook-deliveries')
export class DashboardWebhookDeliveriesController {
  constructor(private readonly deliveries: WebhookDeliveriesService) {}

  @Get()
  @RequirePermission('webhooks:read')
  @ApiOperation({ summary: 'The delivery log, newest first' })
  @ApiEnvelopedResponses({ 200: webhookDeliveryPageSchema })
  list(@Query() query: ListDeliveriesDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...filters } = query;
    return this.deliveries.list(scopeOfMerchantUser(user, environment), filters);
  }

  /** Declared before `:id` routes so `replay` is never read as a delivery id. */
  @Post('replay')
  @HttpCode(200)
  @RequirePermission('webhooks:manage')
  @Audited('webhook_delivery.bulk_replayed', 'webhook_delivery')
  @ApiOperation({
    summary: 'Replay finished deliveries by event type and date range',
    description:
      'Creates a new delivery for each matching delivery whose endpoint is active, at most 500 ' +
      'per request. By default repeats the ones that did not succeed. Repeats are not ' +
      'deduplicated: receivers deduplicate on `MulaPay-Event-Id`.',
  })
  @ApiEnvelopedResponses({ 200: replayResultSchema })
  replay(
    @Query() query: EnvironmentDto,
    @Body() body: ReplayDeliveriesDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.deliveries.replayBulk(scopeOfMerchantUser(user, query.environment), body);
  }

  @Get(':id')
  @RequirePermission('webhooks:read')
  @ApiOperation({ summary: 'Retrieve a delivery' })
  @ApiEnvelopedResponses({ 200: webhookDeliverySchema })
  get(
    @Param() params: IdParamDto,
    @Query() query: EnvironmentDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.deliveries.get(scopeOfMerchantUser(user, query.environment), params.id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @RequirePermission('webhooks:manage')
  @Audited('webhook_delivery.replayed', 'webhook_delivery')
  @ApiOperation({
    summary: 'Replay one finished delivery',
    description: 'Creates a new delivery of the same event. The endpoint must be active.',
  })
  @ApiEnvelopedResponses({ 200: webhookDeliverySchema })
  retry(
    @Param() params: IdParamDto,
    @Query() query: EnvironmentDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.deliveries.replay(scopeOfMerchantUser(user, query.environment), params.id);
  }
}
