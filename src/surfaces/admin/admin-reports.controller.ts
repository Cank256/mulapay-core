/**
 * `/admin/v1/reports` (spec 7.3): platform reports. Asynchronous like the merchant ones: `POST`
 * answers 202, a worker produces the file, `download` returns a link valid for 15 minutes. Staff
 * need `reports:platform` and, for the data a type exposes, its own permission (the ledger, the
 * audit trail, AML, KYC, reconciliation). A merchant's own report types can be requested for a
 * named merchant (`params.merchant`). Staff see only reports staff requested.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { abilityAllows } from '../../common/authz/ability';
import type { Permission } from '../../common/authz/permissions';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { ReportsService, type ReportActor } from '../../modules/reports/reports.service';
import {
  adminReportPageSchema,
  adminReportSchema,
  downloadSchema,
  toAdminReport,
} from '../../modules/reports/report.views';
import { adminReportListSchema, requestAdminReportSchema } from '../shared/support.schemas';
import { refParamSchema } from '../shared/schemas';

class RequestDto extends createZodDto(requestAdminReportSchema) {}
class ListDto extends createZodDto(adminReportListSchema) {}
class RefDto extends createZodDto(refParamSchema) {}

const actorOf = (staff: StaffPrincipal): ReportActor => ({
  staff: {
    userId: staff.userId,
    userRef: staff.userRef,
    can: (permission) => abilityAllows(staff.ability, permission as Permission),
  },
});

@ApiTags('Reports')
@Controller('reports')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(202)
  @RequirePermission('reports:platform')
  @Audited('report.requested', 'report')
  @ApiOperation({
    summary: 'Request a platform report',
    description:
      'Types: ledger_account_statement, reconciliation_exceptions, aml_alerts, kyc_status, audit_trail, merchant_performance, and the merchant types for a named merchant.',
  })
  @ApiEnvelopedResponses({ 202: adminReportSchema })
  async request(@Body() body: RequestDto, @CurrentStaff() staff: StaffPrincipal) {
    return toAdminReport(
      await this.reports.request(
        { type: body.type, format: body.format, params: body.params },
        actorOf(staff)
      )
    );
  }

  @Get()
  @RequirePermission('reports:platform')
  @ApiOperation({ summary: 'Reports staff requested, newest first' })
  @ApiEnvelopedResponses({ 200: adminReportPageSchema })
  async list(@Query() q: ListDto, @CurrentStaff() staff: StaffPrincipal) {
    const page = await this.reports.list(
      { type: q.type, status: q.status, limit: q.limit, cursor: q.cursor },
      actorOf(staff)
    );
    return { items: page.items.map(toAdminReport), nextCursor: page.nextCursor };
  }

  @Get(':ref')
  @RequirePermission('reports:platform')
  @ApiOperation({ summary: 'One report and its status' })
  @ApiEnvelopedResponses({ 200: adminReportSchema })
  async get(@Param() p: RefDto, @CurrentStaff() staff: StaffPrincipal) {
    return toAdminReport(await this.reports.get(p.ref, actorOf(staff)));
  }

  @Get(':ref/download')
  @RequirePermission('reports:platform')
  @ApiOperation({ summary: 'A presigned download link, valid for 15 minutes (audited)' })
  @ApiEnvelopedResponses({ 200: downloadSchema })
  async download(@Param() p: RefDto, @CurrentStaff() staff: StaffPrincipal) {
    const link = await this.reports.downloadLink(p.ref, actorOf(staff));
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), filename: link.filename };
  }
}
