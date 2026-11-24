/**
 * `/dashboard/v1/events` (spec 7.2): the merchant's own event feed — list and detail.
 * Read-only views of the events the merchant subscribed to (for webhook catch-up and
 * audit). The session is bound to one merchant; the environment is chosen per request.
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
import { MAX_PAGE_LIMIT, pageQuerySchema } from '../../common/pagination/cursor';
import { MerchantEventsService } from '../../modules/events/merchant-events.service';
import {
  merchantEventSchema,
  merchantEventPageSchema,
} from '../../modules/events/merchant-event.views';
import { refParamSchema } from '../shared/schemas';
import { dateTimeSchema, environmentSchema } from '../shared/payment.schemas';

const listEventsSchema = z.strictObject({
  type: z.string().min(1).max(64).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  environment: environmentSchema.default('live'),
  ...pageQuerySchema(MAX_PAGE_LIMIT),
});

class ListEventsDto extends createZodDto(listEventsSchema) {}
class RefParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Events')
@Controller('events')
export class DashboardEventsController {
  constructor(private readonly events: MerchantEventsService) {}

  @Get()
  @RequirePermission('events:read')
  @ApiOperation({ summary: 'List merchant events, newest first' })
  @ApiEnvelopedResponses({ 200: merchantEventPageSchema })
  async list(@Query() query: ListEventsDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...filters } = query;
    const scope = scopeOfMerchantUser(user, environment);
    return this.events.list(scope, {
      type: filters.type as Parameters<typeof this.events.list>[1]['type'],
      from: filters.from,
      to: filters.to,
      limit: filters.limit,
      cursor: filters.cursor,
    });
  }

  @Get(':ref')
  @RequirePermission('events:read')
  @ApiOperation({ summary: 'Retrieve a single event' })
  @ApiEnvelopedResponses({ 200: merchantEventSchema })
  async get(
    @Param() params: RefParamDto,
    @Query('environment') env: 'test' | 'live',
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const scope = scopeOfMerchantUser(user, env ?? 'live');
    return this.events.get(scope, params.ref);
  }
}
