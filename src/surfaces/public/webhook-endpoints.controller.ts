/**
 * `/v1/webhook-endpoints` (spec 7.1): register where MulaPay sends events, and with which
 * secret. The signing secret is in the create and rotate responses only.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiErrors } from '../../common/openapi/api-docs.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  createdWebhookEndpointSchema,
  webhookEndpointSchema,
} from '../../modules/webhooks/webhook-endpoint.views';
import { WebhookEndpointsService } from '../../modules/webhooks/webhook-endpoints.service';
import {
  createWebhookEndpointSchema,
  rotateSecretSchema,
  updateWebhookEndpointSchema,
} from '../shared/developer.schemas';
import { okSchema } from '../shared/auth.views';
import { refParamSchema } from '../shared/schemas';

class CreateEndpointDto extends createZodDto(createWebhookEndpointSchema) {}
class UpdateEndpointDto extends createZodDto(updateWebhookEndpointSchema) {}
class RotateSecretDto extends createZodDto(rotateSecretSchema) {}
class EndpointParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Webhook endpoints')
@Controller('webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointsService) {}

  @Post()
  @RequirePermission('webhooks:write')
  @Audited('webhook_endpoint.created', 'webhook_endpoint')
  @ApiErrors('WEBHOOK_URL_REJECTED', 'WEBHOOK_ENDPOINT_LIMIT_REACHED')
  @ApiOperation({
    summary: 'Register a webhook endpoint',
    description:
      'The URL must be https and public. `enabledEvents` lists event types, or `*` for all. ' +
      'The response carries the signing `secret` once; store it. Deliveries are signed as ' +
      '`MulaPay-Signature: t=<unix>,v1=<hmac-sha256 of "t.payload">`.',
  })
  @ApiEnvelopedResponses({ 201: createdWebhookEndpointSchema })
  create(@Body() body: CreateEndpointDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.endpoints.create(scopeOfApiKey(key), body);
  }

  @Get()
  @RequirePermission('webhooks:read')
  @ApiOperation({ summary: 'List webhook endpoints' })
  @ApiEnvelopedResponses({ 200: z.array(webhookEndpointSchema) })
  list(@CurrentApiKey() key: ApiKeyPrincipal) {
    return this.endpoints.list(scopeOfApiKey(key));
  }

  @Get(':ref')
  @RequirePermission('webhooks:read')
  @ApiOperation({ summary: 'Retrieve a webhook endpoint' })
  @ApiEnvelopedResponses({ 200: webhookEndpointSchema })
  get(@Param() params: EndpointParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.endpoints.get(scopeOfApiKey(key), params.ref);
  }

  @Patch(':ref')
  @RequirePermission('webhooks:write')
  @Audited('webhook_endpoint.updated', 'webhook_endpoint')
  @ApiErrors('WEBHOOK_URL_REJECTED')
  @ApiOperation({
    summary: 'Change a webhook endpoint',
    description:
      'Set `status` to `active` to re-enable an endpoint that was disabled or auto-disabled ' +
      'after 50 consecutive failures; its failure count starts over.',
  })
  @ApiEnvelopedResponses({ 200: webhookEndpointSchema })
  update(
    @Param() params: EndpointParamDto,
    @Body() body: UpdateEndpointDto,
    @CurrentApiKey() key: ApiKeyPrincipal
  ) {
    return this.endpoints.update(scopeOfApiKey(key), params.ref, body);
  }

  @Delete(':ref')
  @RequirePermission('webhooks:write')
  @Audited('webhook_endpoint.deleted', 'webhook_endpoint')
  @ApiOperation({
    summary: 'Delete a webhook endpoint',
    description: 'The endpoint stops receiving events; its delivery history is kept.',
  })
  @ApiEnvelopedResponses({ 200: okSchema })
  async remove(@Param() params: EndpointParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    await this.endpoints.delete(scopeOfApiKey(key), params.ref);
    return { ok: true as const };
  }

  @Post(':ref/rotate-secret')
  @HttpCode(200)
  @RequirePermission('webhooks:write')
  @Audited('webhook_endpoint.secret_rotated', 'webhook_endpoint')
  @ApiOperation({
    summary: 'Rotate the signing secret',
    description:
      'Returns the new secret once. For `graceHours` (default 24, at most 72) deliveries are ' +
      'signed with both secrets, so a receiver can switch without losing events.',
  })
  @ApiEnvelopedResponses({ 200: createdWebhookEndpointSchema })
  rotate(
    @Param() params: EndpointParamDto,
    @Body() body: RotateSecretDto,
    @CurrentApiKey() key: ApiKeyPrincipal
  ) {
    return this.endpoints.rotateSecret(scopeOfApiKey(key), params.ref, body.graceHours);
  }
}
