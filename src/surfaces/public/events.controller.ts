/** `/v1/events` (spec 7.1): the merchant's event feed, the same events webhooks deliver. */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import { scopeOfApiKey } from '../../common/auth/merchant-scope';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  merchantEventPageSchema,
  merchantEventSchema,
} from '../../modules/events/merchant-event.views';
import { MerchantEventsService } from '../../modules/events/merchant-events.service';
import { listEventsSchema } from '../shared/developer.schemas';
import { refParamSchema } from '../shared/schemas';

class ListEventsDto extends createZodDto(listEventsSchema) {}
class EventParamDto extends createZodDto(refParamSchema) {}

@ApiTags('Events')
@Controller('events')
export class EventsController {
  constructor(private readonly events: MerchantEventsService) {}

  @Get()
  @RequirePermission('events:read')
  @ApiOperation({
    summary: 'List events, newest first',
    description:
      'Every event the merchant can subscribe to, whether or not an endpoint received it. Use ' +
      'it to catch up after downtime: webhooks are at-least-once and not ordered. A test key ' +
      'sees test events only.',
  })
  @ApiEnvelopedResponses({ 200: merchantEventPageSchema })
  list(@Query() query: ListEventsDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.events.list(scopeOfApiKey(key), query);
  }

  @Get(':ref')
  @RequirePermission('events:read')
  @ApiOperation({ summary: 'Retrieve an event' })
  @ApiEnvelopedResponses({ 200: merchantEventSchema })
  get(@Param() params: EventParamDto, @CurrentApiKey() key: ApiKeyPrincipal) {
    return this.events.get(scopeOfApiKey(key), params.ref);
  }
}
