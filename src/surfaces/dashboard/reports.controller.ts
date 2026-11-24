/**
 * `/merchant/v1/reports` and `/report-schedules` (spec 7.2, 6.12). Reports are asynchronous:
 * `POST` answers 202 with the report, a worker produces the file, and `download` returns a
 * presigned link valid for 15 minutes. The merchant comes from the session; the environment is
 * chosen per request (default `live`).
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { ReportSchedulesService } from '../../modules/reports/report-schedules.service';
import { ReportsService, type ReportActor } from '../../modules/reports/reports.service';
import {
  downloadSchema,
  reportPageSchema,
  reportSchema,
  schedulePageSchema,
  scheduleDetailSchema,
  scheduleSchema,
  toReport,
  toSchedule,
  toScheduleDetail,
} from '../../modules/reports/report.views';
import {
  createScheduleSchema,
  reportEnvironmentSchema,
  reportListSchema,
  requestReportSchema,
  scheduleListSchema,
  updateScheduleSchema,
} from '../shared/support.schemas';
import { refParamSchema } from '../shared/schemas';

class RequestDto extends createZodDto(requestReportSchema) {}
class ListDto extends createZodDto(reportListSchema) {}
class RefDto extends createZodDto(refParamSchema) {}
class EnvDto extends createZodDto(reportEnvironmentSchema) {}
class CreateScheduleDto extends createZodDto(createScheduleSchema) {}
class UpdateScheduleDto extends createZodDto(updateScheduleSchema) {}
class ScheduleListDto extends createZodDto(scheduleListSchema) {}
const deletedSchema = z.object({ deleted: z.literal(true) });

const actorOf = (
  user: MerchantUserPrincipal,
  environment: 'test' | 'live' | undefined
): ReportActor => ({
  merchant: { scope: scopeOfMerchantUser(user, environment ?? 'live'), userId: user.userId },
});

@ApiTags('Reports')
@Controller('reports')
export class DashboardReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(202)
  @RequirePermission('reports:create')
  @Audited('report.requested', 'report')
  @ApiOperation({
    summary: 'Request a report',
    description:
      'Answers 202 at once with the report reference; the file is produced in the background. Poll `GET /reports/{ref}` or wait for the notification, then call `download`. Types: transactions, payments, payouts, refunds, fees, balance_statement, settlement_statement, merchant_performance. Formats: csv and json (xlsx and pdf are refused). Files are kept 7 days.',
  })
  @ApiEnvelopedResponses({ 202: reportSchema })
  async request(@Body() body: RequestDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return toReport(
      await this.reports.request(
        { type: body.type, format: body.format, params: body.params },
        actorOf(user, body.environment)
      )
    );
  }

  @Get()
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'List the merchant’s reports, newest first' })
  @ApiEnvelopedResponses({ 200: reportPageSchema })
  async list(@Query() q: ListDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const page = await this.reports.list(
      { type: q.type, status: q.status, limit: q.limit, cursor: q.cursor },
      actorOf(user, q.environment)
    );
    return { items: page.items.map(toReport), nextCursor: page.nextCursor };
  }

  @Get(':ref')
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'One report and its status' })
  @ApiEnvelopedResponses({ 200: reportSchema })
  async get(
    @Param() p: RefDto,
    @Query() q: EnvDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return toReport(await this.reports.get(p.ref, actorOf(user, q.environment)));
  }

  @Get(':ref/download')
  @RequirePermission('reports:read')
  @ApiOperation({
    summary: 'A presigned download link',
    description: 'Valid for 15 minutes; ask again for a new one while the file exists (7 days).',
  })
  @ApiEnvelopedResponses({ 200: downloadSchema })
  async download(
    @Param() p: RefDto,
    @Query() q: EnvDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const link = await this.reports.downloadLink(p.ref, actorOf(user, q.environment));
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), filename: link.filename };
  }
}

@ApiTags('Reports')
@Controller('report-schedules')
export class DashboardReportSchedulesController {
  constructor(private readonly schedules: ReportSchedulesService) {}

  @Post()
  @RequirePermission('reports:create')
  @Audited('report_schedule.created', 'report_schedule')
  @ApiOperation({
    summary: 'Schedule a report',
    description:
      'A report is produced for the day, week or month before each run. Recipients must be people of this business: they are told in the dashboard and by email when it is ready. A schedule turns itself off after repeated failures.',
  })
  @ApiEnvelopedResponses({ 201: scheduleSchema })
  async create(
    @Body() body: CreateScheduleDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return toSchedule(
      await this.schedules.create(
        {
          reportType: body.reportType,
          params: body.params,
          period: body.period,
          cron: body.cron,
          timezone: body.timezone,
          recipients: body.recipients,
          format: body.format,
        },
        actorOf(user, body.environment)
      )
    );
  }

  @Get()
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'List report schedules' })
  @ApiEnvelopedResponses({ 200: schedulePageSchema })
  async list(@Query() q: ScheduleListDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const page = await this.schedules.list(
      { limit: q.limit, cursor: q.cursor },
      actorOf(user, q.environment)
    );
    return { items: page.items.map(toSchedule), nextCursor: page.nextCursor };
  }

  @Get(':ref')
  @RequirePermission('reports:read')
  @ApiOperation({ summary: 'One schedule with its last 20 runs' })
  @ApiEnvelopedResponses({ 200: scheduleDetailSchema })
  async get(
    @Param() p: RefDto,
    @Query() q: EnvDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    const found = await this.schedules.get(p.ref, actorOf(user, q.environment));
    return toScheduleDetail(found.schedule, found.history);
  }

  @Patch(':ref')
  @RequirePermission('reports:create')
  @Audited('report_schedule.updated', 'report_schedule')
  @ApiOperation({ summary: 'Change a schedule, or switch it on or off' })
  @ApiEnvelopedResponses({ 200: scheduleSchema })
  async update(
    @Param() p: RefDto,
    @Query() q: EnvDto,
    @Body() body: UpdateScheduleDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return toSchedule(await this.schedules.update(p.ref, body, actorOf(user, q.environment)));
  }

  @Delete(':ref')
  @HttpCode(200)
  @RequirePermission('reports:create')
  @Audited('report_schedule.deleted', 'report_schedule')
  @ApiOperation({ summary: 'Delete a schedule (reports already produced stay)' })
  @ApiEnvelopedResponses({ 200: deletedSchema })
  async remove(
    @Param() p: RefDto,
    @Query() q: EnvDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    await this.schedules.remove(p.ref, actorOf(user, q.environment));
    return { deleted: true as const };
  }
}
