/**
 * `/admin/v1/aml/alerts` and `/admin/v1/aml/cases` (spec 7.3): the alert queue, the actions an
 * analyst takes on an alert, and cases with their notes, history and STR package.
 *
 * Alerts and cases are worked by `aml:work`. Resolving an alert and generating an STR package
 * are step-up actions; every change, including closing a case, is audited. Nothing here changes
 * a transaction or a ledger entry; the only money effect is releasing a hold the alert placed.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { AmlStaffDirectory } from '../../modules/aml/aml-staff.directory';
import { AmlAlertsService, type AlertListItem } from '../../modules/aml/alerts/aml-alerts.service';
import { AmlCasesService } from '../../modules/aml/cases/aml-cases.service';
import { AmlStrExportService } from '../../modules/aml/cases/aml-str-export.service';
import { MerchantsRepository } from '../../modules/merchants/merchants.repository';
import type { Clock } from '../../common/clock/clock';
import { CLOCK } from '../../common/tokens';
import { Inject } from '@nestjs/common';
import {
  alertListQuerySchema,
  alertPageSchema,
  alertSchema,
  assignAlertSchema,
  caseDetailSchema,
  caseListQuerySchema,
  casePageSchema,
  caseSchema,
  createCaseSchema,
  escalateAlertSchema,
  patchCaseSchema,
  refParam,
  resolveAlertSchema,
  strResultSchema,
} from '../shared/aml.schemas';
import { toAlertView, toCaseView } from '../shared/aml.views';

class AlertListDto extends createZodDto(alertListQuerySchema) {}
class RefDto extends createZodDto(refParam) {}
class AssignDto extends createZodDto(assignAlertSchema) {}
class EscalateDto extends createZodDto(escalateAlertSchema) {}
class ResolveDto extends createZodDto(resolveAlertSchema) {}
class CaseListDto extends createZodDto(caseListQuerySchema) {}
class CreateCaseDto extends createZodDto(createCaseSchema) {}
class PatchCaseDto extends createZodDto(patchCaseSchema) {}

@ApiTags('AML')
@Controller('aml')
export class AdminAmlCasesController {
  constructor(
    private readonly alerts: AmlAlertsService,
    private readonly cases: AmlCasesService,
    private readonly str: AmlStrExportService,
    private readonly directory: AmlStaffDirectory,
    private readonly merchants: MerchantsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  private async alertViews(items: readonly AlertListItem[]) {
    const [staff, holds, cases] = await Promise.all([
      this.directory.refsOf(items.map((i) => i.row.assignedTo)),
      this.directory.holdRefsOf(items.map((i) => i.row.holdId)),
      this.directory.caseRefsOf(items.map((i) => i.row.caseId)),
    ]);
    const now = this.clock.now();
    return items.map((i) => toAlertView(i, staff, now, holds, cases));
  }

  // ---- alerts ----
  @Get('alerts')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'The alert queue, newest first' })
  @ApiEnvelopedResponses({ 200: alertPageSchema })
  async listAlerts(@Query() q: AlertListDto) {
    const merchant = q.merchant ? await this.merchants.findByRef(q.merchant) : undefined;
    if (q.merchant && !merchant) return { items: [], nextCursor: null };
    const page = await this.alerts.list({
      status: q.status,
      severity: q.severity,
      merchantId: merchant?.id,
      assignedTo: q.assignee ? await this.directory.idOf(q.assignee) : undefined,
      ruleCode: q.rule,
      overdue: q.overdue,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: await this.alertViews(page.items), nextCursor: page.nextCursor };
  }

  @Get('alerts/:ref')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'One alert' })
  @ApiEnvelopedResponses({ 200: alertSchema })
  async getAlert(@Param() p: RefDto) {
    const found = await this.alerts.get(p.ref);
    return (await this.alertViews([found]))[0];
  }

  @Post('alerts/:ref/assign')
  @HttpCode(200)
  @RequirePermission('aml:work')
  @Audited('aml.alert.assigned', 'aml_alert')
  @ApiOperation({ summary: 'Assign an alert to an investigator' })
  @ApiEnvelopedResponses({ 200: alertSchema })
  async assign(@Param() p: RefDto, @Body() body: AssignDto) {
    await this.alerts.assign(p.ref, await this.directory.idOf(body.assignee), body.assignee);
    return (await this.alertViews([await this.alerts.get(p.ref)]))[0];
  }

  @Post('alerts/:ref/escalate')
  @HttpCode(200)
  @RequirePermission('aml:work')
  @Audited('aml.alert.escalated', 'aml_alert')
  @ApiOperation({ summary: 'Escalate an alert' })
  @ApiEnvelopedResponses({ 200: alertSchema })
  async escalate(@Param() p: RefDto, @Body() body: EscalateDto) {
    await this.alerts.escalate(p.ref, body.note);
    return (await this.alertViews([await this.alerts.get(p.ref)]))[0];
  }

  @Post('alerts/:ref/resolve')
  @HttpCode(200)
  @RequirePermission('aml:work')
  @RequiresStepUp()
  @Audited('aml.alert.resolved', 'aml_alert')
  @ApiOperation({
    summary: 'Resolve an alert as a false positive or confirmed',
    description:
      'A false positive releases the hold the alert placed. A confirmed alert keeps it until the case decides.',
  })
  @ApiEnvelopedResponses({ 200: alertSchema })
  async resolve(
    @Param() p: RefDto,
    @Body() body: ResolveDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    await this.alerts.resolve(p.ref, body.outcome, body.note, staff.userId, body.releaseHold);
    return (await this.alertViews([await this.alerts.get(p.ref)]))[0];
  }

  // ---- cases ----
  @Get('cases')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'AML cases, newest first' })
  @ApiEnvelopedResponses({ 200: casePageSchema })
  async listCases(@Query() q: CaseListDto) {
    const merchant = q.merchant ? await this.merchants.findByRef(q.merchant) : undefined;
    if (q.merchant && !merchant) return { items: [], nextCursor: null };
    const page = await this.cases.list({
      status: q.status,
      merchantId: merchant?.id,
      assignedTo: q.assignee ? await this.directory.idOf(q.assignee) : undefined,
      open: q.open,
      limit: q.limit,
      cursor: q.cursor,
    });
    const staff = await this.directory.refsOf(page.items.map((i) => i.row.assignedTo));
    return {
      items: page.items.map((i) => toCaseView(i.row, i.merchantRef, staff)),
      nextCursor: page.nextCursor,
    };
  }

  @Post('cases')
  @RequirePermission('aml:work')
  @Audited('aml.case.opened', 'aml_case')
  @ApiOperation({ summary: 'Open a case for a merchant, optionally with its alerts' })
  @ApiEnvelopedResponses({ 201: caseSchema })
  async createCase(@Body() body: CreateCaseDto, @CurrentStaff() staff: StaffPrincipal) {
    const row = await this.cases.create(
      {
        merchantRef: body.merchant,
        title: body.title,
        summary: body.summary,
        severity: body.severity,
        alertRefs: body.alerts,
      },
      staff.userId
    );
    return toCaseView(row, body.merchant, new Map());
  }

  @Get('cases/:ref')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'A case with its alerts, notes, STR packages and audit history' })
  @ApiEnvelopedResponses({ 200: caseDetailSchema })
  async getCase(@Param() p: RefDto) {
    const detail = await this.cases.get(p.ref);
    const alertItems: AlertListItem[] = detail.alerts.map((row) => ({
      row,
      merchantRef: detail.merchantRef,
      transactionRef: null,
    }));
    const refs = await this.directory.refsOf([
      detail.row.assignedTo,
      ...detail.notes.map((n) => n.authorId),
    ]);
    return {
      ...toCaseView(detail.row, detail.merchantRef, refs),
      alerts: await this.alertViews(alertItems),
      notes: detail.notes.map((n) => ({
        at: n.createdAt.toISOString(),
        author: n.authorId ? (refs.get(n.authorId) ?? null) : null,
        body: n.body,
      })),
      strPackages: detail.strPackages.map((s) => ({
        id: s.ref,
        sha256: s.fileHash,
        sizeBytes: s.sizeBytes,
        createdAt: s.createdAt.toISOString(),
      })),
      history: detail.history.map((h) => ({
        seq: h.seq,
        at: h.createdAt,
        action: h.action,
        actor: h.actorLabel ?? h.actorId,
      })),
    };
  }

  @Patch('cases/:ref')
  @RequirePermission('aml:work')
  @Audited('aml.case.updated', 'aml_case')
  @ApiOperation({
    summary:
      'Work a case: assign, add notes or alerts, close it with an outcome, record the STR filing',
  })
  @ApiEnvelopedResponses({ 200: caseSchema })
  async patchCase(
    @Param() p: RefDto,
    @Body() body: PatchCaseDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    const row = await this.cases.update(
      p.ref,
      {
        assigneeUserId:
          body.assignee === undefined
            ? undefined
            : body.assignee === null
              ? null
              : await this.directory.idOf(body.assignee),
        status: body.status,
        outcome: body.outcome,
        title: body.title,
        summary: body.summary,
        severity: body.severity,
        note: body.note,
        addAlertRefs: body.addAlerts,
        strReference: body.strReference,
      },
      staff.userId
    );
    const detail = await this.cases.get(row.ref);
    const refs = await this.directory.refsOf([row.assignedTo]);
    return toCaseView(row, detail.merchantRef, refs);
  }

  @Post('cases/:ref/str')
  @RequirePermission('aml:str')
  @RequiresStepUp()
  @Audited('aml.case.str_generated', 'aml_case')
  @ApiOperation({
    summary: 'Generate an STR package for a case',
    description:
      'Builds the package, stores it in object storage, records its SHA-256 and returns a ' +
      'short-lived download link. Each call makes a new numbered package.',
  })
  @ApiEnvelopedResponses({ 201: strResultSchema })
  async generateStr(@Param() p: RefDto, @CurrentStaff() staff: StaffPrincipal) {
    const result = await this.str.generate(p.ref, staff.userId);
    return {
      id: result.package.ref,
      sha256: result.package.fileHash,
      sizeBytes: result.package.sizeBytes,
      alertCount: result.package.alertCount,
      downloadUrl: result.download.url,
      expiresAt: result.download.expiresAt.toISOString(),
    };
  }
}
