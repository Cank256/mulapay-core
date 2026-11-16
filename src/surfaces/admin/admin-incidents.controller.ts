/**
 * `/admin/v1/incidents` (spec 7.3): the incident lifecycle. Staff open incidents, move them
 * through investigating, identified and monitoring, post internal and public updates, resolve
 * them and write the postmortem. Public updates, and only those, feed `GET /v1/status`.
 * Incidents opened by the platform's monitors appear here with their `source`.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  incidentDetailSchema,
  incidentPageSchema,
  toIncident,
  toIncidentDetail,
} from '../../modules/incidents/incident.views';
import { IncidentsService } from '../../modules/incidents/incidents.service';
import {
  createIncidentSchema,
  incidentListSchema,
  incidentUpdateBodySchema,
  postmortemBodySchema,
  resolveIncidentSchema,
  updateIncidentSchema,
} from '../shared/support.schemas';
import { refParamSchema } from '../shared/schemas';

class ListDto extends createZodDto(incidentListSchema) {}
class RefDto extends createZodDto(refParamSchema) {}
class CreateDto extends createZodDto(createIncidentSchema) {}
class UpdateDto extends createZodDto(updateIncidentSchema) {}
class UpdateBodyDto extends createZodDto(incidentUpdateBodySchema) {}
class ResolveDto extends createZodDto(resolveIncidentSchema) {}
class PostmortemDto extends createZodDto(postmortemBodySchema) {}

const staffOf = (s: StaffPrincipal) => ({ userId: s.userId, userRef: s.userRef });

@ApiTags('Incidents')
@Controller('incidents')
export class AdminIncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @RequirePermission('incidents:read')
  @ApiOperation({ summary: 'Incidents, newest first' })
  @ApiEnvelopedResponses({ 200: incidentPageSchema })
  async list(@Query() q: ListDto) {
    const page = await this.incidents.list({
      status: q.status,
      open: q.open,
      severity: q.severity,
      source: q.source,
      limit: q.limit,
      cursor: q.cursor,
    });
    return {
      items: page.items.map((i) =>
        toIncident(i.row, { commanderRef: i.commanderRef, merchantRefs: [] })
      ),
      nextCursor: page.nextCursor,
    };
  }

  @Post()
  @RequirePermission('incidents:manage')
  @Audited('incident.opened', 'incident')
  @ApiOperation({
    summary: 'Open an incident',
    description: 'Sev1 and sev2 incidents notify staff on every channel they have on.',
  })
  @ApiEnvelopedResponses({ 201: incidentDetailSchema })
  async create(@Body() body: CreateDto, @CurrentStaff() staff: StaffPrincipal) {
    return toIncidentDetail(
      await this.incidents.create(
        {
          title: body.title,
          severity: body.severity,
          impact: body.impact,
          affectedServices: body.affectedServices,
          affectedMerchantRefs: body.affectedMerchants,
          commanderRef: body.commander,
          startedAt: body.startedAt,
          message: body.message,
        },
        staffOf(staff)
      )
    );
  }

  @Get(':ref')
  @RequirePermission('incidents:read')
  @ApiOperation({ summary: 'One incident with its timeline and postmortem' })
  @ApiEnvelopedResponses({ 200: incidentDetailSchema })
  async get(@Param() p: RefDto) {
    return toIncidentDetail(await this.incidents.get(p.ref));
  }

  @Patch(':ref')
  @RequirePermission('incidents:manage')
  @Audited('incident.updated', 'incident')
  @ApiOperation({
    summary: 'Change an incident',
    description:
      'Severity, status (to resolve, use the resolve route), services, merchants, commander. `public: false` takes it off the status page.',
  })
  @ApiEnvelopedResponses({ 200: incidentDetailSchema })
  async update(@Param() p: RefDto, @Body() body: UpdateDto, @CurrentStaff() staff: StaffPrincipal) {
    return toIncidentDetail(
      await this.incidents.update(
        p.ref,
        {
          title: body.title,
          severity: body.severity,
          impact: body.impact,
          status: body.status,
          affectedServices: body.affectedServices,
          affectedMerchantRefs: body.affectedMerchants,
          commanderRef: body.commander,
          public: body.public,
        },
        staffOf(staff)
      )
    );
  }

  @Post(':ref/updates')
  @HttpCode(200)
  @RequirePermission('incidents:manage')
  @Audited('incident.update_added', 'incident')
  @ApiOperation({
    summary: 'Add to the timeline',
    description:
      '`public: true` also publishes it on the status page and makes the incident public. Write nothing internal in a public update.',
  })
  @ApiEnvelopedResponses({ 200: incidentDetailSchema })
  async addUpdate(
    @Param() p: RefDto,
    @Body() body: UpdateBodyDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toIncidentDetail(await this.incidents.addUpdate(p.ref, body, staffOf(staff)));
  }

  @Post(':ref/resolve')
  @HttpCode(200)
  @RequirePermission('incidents:manage')
  @Audited('incident.resolved', 'incident')
  @ApiOperation({ summary: 'Resolve an incident' })
  @ApiEnvelopedResponses({ 200: incidentDetailSchema })
  async resolve(
    @Param() p: RefDto,
    @Body() body: ResolveDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toIncidentDetail(await this.incidents.resolve(p.ref, body, staffOf(staff)));
  }

  @Post(':ref/postmortem')
  @HttpCode(200)
  @RequirePermission('incidents:manage')
  @Audited('incident.postmortem_saved', 'incident')
  @ApiOperation({
    summary: 'Write or replace the postmortem',
    description:
      'Editable until published; publishing needs a resolved incident and makes it final. Never public.',
  })
  @ApiEnvelopedResponses({ 200: incidentDetailSchema })
  async postmortem(
    @Param() p: RefDto,
    @Body() body: PostmortemDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toIncidentDetail(await this.incidents.writePostmortem(p.ref, body, staffOf(staff)));
  }
}
