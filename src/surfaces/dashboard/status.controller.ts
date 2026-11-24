/** `GET /merchant/v1/status` (spec 7.2): the same public incident feed as `GET /v1/status`, for the dashboard. */
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authenticated } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { publicStatusSchema, toPublicStatus } from '../../modules/incidents/incident.views';
import { IncidentsService } from '../../modules/incidents/incidents.service';

@ApiTags('Status')
@Controller('status')
export class DashboardStatusController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Platform status and public incident updates' })
  @ApiEnvelopedResponses({ 200: publicStatusSchema })
  async status() {
    return toPublicStatus(await this.incidents.publicFeed());
  }
}
