/**
 * `GET /v1/status` (spec 7.4): the public status page feed. No authentication. It carries the
 * public updates of public incidents and nothing else (no titles, severities, internal services,
 * merchants, staff or postmortems), so it is safe to cache at the edge and to leave open.
 */
import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { publicStatusSchema, toPublicStatus } from '../../modules/incidents/incident.views';
import { IncidentsService } from '../../modules/incidents/incidents.service';

@ApiTags('Status')
@Controller('status')
export class StatusController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'public, max-age=30')
  @ApiOperation({
    summary: 'Platform status and public incident updates',
    description: 'Unauthenticated. Open public incidents, and those resolved in the last 14 days.',
  })
  @ApiEnvelopedResponses({ 200: publicStatusSchema })
  async status() {
    return toPublicStatus(await this.incidents.publicFeed());
  }
}
