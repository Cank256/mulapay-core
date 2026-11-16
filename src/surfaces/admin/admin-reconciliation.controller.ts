/**
 * `/admin/v1/reconciliation/*` (spec 7.3): run reconciliation, work the exception queue,
 * decide resolutions, upload and inspect provider statements, and read the status board.
 *
 * Reconciliation never changes financial state by itself. A resolution that moves money (a
 * reversing entry or a write-off) is requested here and decided by a different staff member.
 * Exceptions are addressed by their `rce_` ref (the spec writes `:id`). The presigned upload
 * (`statements/presign`) needs object storage, which is not built; rows go in the body.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { markAuditNotApplicable } from '../../common/context/request-context';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  ReconciliationExceptionsService,
  type ResolveInput,
} from '../../modules/reconciliation/exceptions.service';
import type { ExceptionRow } from '../../modules/reconciliation/reconciliation-exceptions.repository';
import { ReconciliationReportsService } from '../../modules/reconciliation/reconciliation-reports.service';
import { ReconciliationScheduler } from '../../modules/reconciliation/reconciliation-scheduler.service';
import {
  toExceptionView,
  toNoteView,
  toRequestView,
  toRunView,
  toStatementRowView,
  toStatementView,
} from '../../modules/reconciliation/reconciliation.views';
import { StatementsService } from '../../modules/reconciliation/statements.service';
import { SettlementBatchesRepository } from '../../modules/settlement/settlement-batches.repository';
import { refParamSchema } from '../shared/schemas';
import {
  assignSchema,
  decideSchema,
  exceptionDetailSchema,
  exceptionPageSchema,
  historySchema,
  listExceptionsSchema,
  listHistorySchema,
  listRunsSchema,
  listStatementsSchema,
  noteSchema,
  pendingRequestsSchema,
  resolveResultSchema,
  resolveSchema,
  runPageSchema,
  runSchema,
  startRunResultSchema,
  startRunSchema,
  statementPageSchema,
  statementRowsQuerySchema,
  statementRowsSchema,
  statementUploadSchema,
  statusSchema,
  uploadStatementSchema,
} from '../shared/settlement.schemas';

class StartRunDto extends createZodDto(startRunSchema) {}
class ListRunsDto extends createZodDto(listRunsSchema) {}
class RefParamDto extends createZodDto(refParamSchema) {}
class ListExceptionsDto extends createZodDto(listExceptionsSchema) {}
class AssignDto extends createZodDto(assignSchema) {}
class NoteDto extends createZodDto(noteSchema) {}
class ResolveDto extends createZodDto(resolveSchema) {}
class DecideDto extends createZodDto(decideSchema) {}
class UploadStatementDto extends createZodDto(uploadStatementSchema) {}
class ListStatementsDto extends createZodDto(listStatementsSchema) {}
class StatementRowsDto extends createZodDto(statementRowsQuerySchema) {}
class HistoryDto extends createZodDto(listHistorySchema) {}

@ApiTags('Reconciliation')
@Controller('reconciliation')
export class AdminReconciliationController {
  constructor(
    private readonly scheduler: ReconciliationScheduler,
    private readonly reports: ReconciliationReportsService,
    private readonly exceptions: ReconciliationExceptionsService,
    private readonly statements: StatementsService,
    private readonly batchRepo: SettlementBatchesRepository
  ) {}

  // ---- runs ----
  @Get('status')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'The newest run of each kind, open exceptions and pending approvals' })
  @ApiEnvelopedResponses({ 200: statusSchema })
  async status() {
    const s = await this.reports.status();
    return {
      ...s,
      latestRuns: s.latestRuns.map((r) => ({ kind: r.kind, run: r.run ? toRunView(r.run) : null })),
    };
  }

  @Get('runs')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'Reconciliation runs, newest first' })
  @ApiEnvelopedResponses({ 200: runPageSchema })
  async listRuns(@Query() q: ListRunsDto) {
    const page = await this.reports.listRuns(q);
    return { items: page.items.map(toRunView), nextCursor: page.nextCursor };
  }

  @Post('runs')
  @HttpCode(200)
  @RequirePermission('reconciliation:work')
  @Audited('reconciliation.run.requested', 'reconciliation_run')
  @ApiOperation({
    summary: 'Run a reconciliation now',
    description:
      'Keyed by `idempotencyKey`: sending it again returns the first run and raises nothing twice. ' +
      'A run of the same kind and scope that is already running answers `in_progress`.',
  })
  @ApiEnvelopedResponses({ 200: startRunResultSchema })
  async startRun(@Body() body: StartRunDto, @CurrentStaff() staff: StaffPrincipal) {
    const merchantId = body.merchant
      ? await this.batchRepo.merchantIdByRef(body.merchant)
      : undefined;
    if (body.merchant && !merchantId) throw new AppError('NOT_FOUND');
    if (body.kind === 'provider_statement' && !body.statement) {
      throw new AppError('VALIDATION_FAILED', {
        details: { fields: [{ path: 'statement', message: 'is required' }] },
      });
    }
    const result = await this.scheduler.runManual({
      kind: body.kind,
      scope: {
        environment: body.environment,
        currency: body.currency,
        merchantId,
        statement: body.statement,
      },
      idempotencyKey: body.idempotencyKey,
      userId: staff.userId,
    });
    if (result.outcome !== 'completed') markAuditNotApplicable();
    return { outcome: result.outcome, run: result.run ? toRunView(result.run) : null };
  }

  @Get('runs/:ref')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'One run' })
  @ApiEnvelopedResponses({ 200: runSchema })
  async getRun(@Param() p: RefParamDto) {
    return toRunView(await this.reports.getRun(p.ref));
  }

  // ---- exceptions ----
  @Get('exceptions')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'The exception queue, newest first' })
  @ApiEnvelopedResponses({ 200: exceptionPageSchema })
  async listExceptions(@Query() q: ListExceptionsDto) {
    const page = await this.exceptions.list({
      status: q.status,
      kind: q.kind,
      severity: q.severity,
      assignedTo: q.assignedTo ? await this.exceptions.staffId(q.assignedTo) : undefined,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: await this.views(page.items), nextCursor: page.nextCursor };
  }

  @Get('unresolved')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'Unresolved discrepancies: open and investigating exceptions' })
  @ApiEnvelopedResponses({ 200: exceptionPageSchema })
  async unresolved(@Query() q: ListExceptionsDto) {
    const page = await this.reports.unresolved({
      kind: q.kind,
      severity: q.severity,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: await this.views(page.items), nextCursor: page.nextCursor };
  }

  @Get('history')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'Resolution history: resolved and written-off exceptions' })
  @ApiEnvelopedResponses({ 200: historySchema })
  async history(@Query() q: HistoryDto) {
    return { items: await this.views(await this.reports.history(q.limit)) };
  }

  @Get('pending-resolutions')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'Reversals and write-offs waiting for a second person' })
  @ApiEnvelopedResponses({ 200: pendingRequestsSchema })
  async pending() {
    return { items: (await this.exceptions.listPendingRequests()).map((r) => toRequestView(r)) };
  }

  @Get('exceptions/:ref')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'One exception with its notes and resolution requests' })
  @ApiEnvelopedResponses({ 200: exceptionDetailSchema })
  async getException(@Param() p: RefParamDto) {
    const d = await this.exceptions.get(p.ref);
    return {
      exception: await this.view(d.exception),
      notes: d.notes.map(toNoteView),
      resolutionRequests: d.requests.map((r) => toRequestView(r)),
    };
  }

  @Post('exceptions/:ref/assign')
  @HttpCode(200)
  @RequirePermission('reconciliation:work')
  @Audited('reconciliation.exception.assigned', 'reconciliation_exception')
  @ApiOperation({ summary: 'Assign an exception and mark it investigating' })
  @ApiEnvelopedResponses({ 200: exceptionDetailSchema.shape.exception })
  async assign(
    @Param() p: RefParamDto,
    @Body() body: AssignDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return await this.view(
      await this.exceptions.assign(
        p.ref,
        await this.exceptions.staffId(body.assignee),
        staff.userId
      )
    );
  }

  @Post('exceptions/:ref/notes')
  @RequirePermission('reconciliation:work')
  @Audited('reconciliation.exception.noted', 'reconciliation_exception')
  @ApiOperation({ summary: 'Add an investigation note' })
  @ApiEnvelopedResponses({ 201: z.object({ kind: z.string(), body: z.string(), at: z.string() }) })
  async note(
    @Param() p: RefParamDto,
    @Body() body: NoteDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toNoteView(await this.exceptions.addNote(p.ref, body.body, staff.userId));
  }

  @Post('exceptions/:ref/resolve')
  @HttpCode(200)
  @RequirePermission('reconciliation:work')
  @RequiresStepUp()
  @Audited('reconciliation.exception.resolve_requested', 'reconciliation_exception')
  @ApiOperation({
    summary: 'Resolve an exception',
    description:
      '`matched_manually` resolves at once. `corrected_with_reversal` and `written_off` post to the ledger, so they create a request that someone else must approve.',
  })
  @ApiEnvelopedResponses({ 200: resolveResultSchema })
  async resolve(
    @Param() p: RefParamDto,
    @Body() body: ResolveDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    const input: ResolveInput =
      body.resolution === 'corrected_with_reversal'
        ? { resolution: body.resolution, note: body.note, entryRef: body.entryRef as string }
        : body.resolution === 'written_off'
          ? {
              resolution: body.resolution,
              note: body.note,
              accountCode: body.accountCode as string,
              amountMinor: body.amountMinor as string,
            }
          : { resolution: body.resolution, note: body.note };
    const result = await this.exceptions.resolve(p.ref, input, staff.userId);
    return {
      exception: await this.view(result.exception),
      request: result.request ? toRequestView(result.request) : null,
    };
  }

  @Post('resolutions/:ref/decide')
  @HttpCode(200)
  @RequirePermission('reconciliation:approve')
  @RequiresStepUp()
  @Audited('reconciliation.resolution.decided', 'reconciliation_exception')
  @ApiOperation({ summary: 'Approve or reject a reversal or write-off. Never the requester' })
  @ApiEnvelopedResponses({ 200: resolveResultSchema })
  async decide(
    @Param() p: RefParamDto,
    @Body() body: DecideDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    const result = await this.exceptions.decide(
      p.ref,
      body.decision,
      body.note ?? null,
      staff.userId
    );
    return {
      exception: await this.view(result.exception),
      request: result.request ? toRequestView(result.request) : null,
    };
  }

  // ---- statements ----
  @Post('statements')
  @RequirePermission('reconciliation:work')
  @Audited('reconciliation.statement.uploaded', 'provider_statement')
  @ApiOperation({
    summary: 'Upload a provider statement',
    description: 'Stored in full and queued for matching. The same statement twice is a 409.',
  })
  @ApiEnvelopedResponses({ 201: statementUploadSchema })
  async upload(@Body() body: UploadStatementDto, @CurrentStaff() staff: StaffPrincipal) {
    return toStatementView(await this.statements.upload(body, `user:${staff.userId}`));
  }

  @Get('statements')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'Uploaded provider statements, newest first' })
  @ApiEnvelopedResponses({ 200: statementPageSchema })
  async listStatements(@Query() q: ListStatementsDto) {
    const page = await this.statements.list(q);
    return { items: page.items.map(toStatementView), nextCursor: page.nextCursor };
  }

  @Get('statements/:ref/rows')
  @RequirePermission('reconciliation:read')
  @ApiOperation({ summary: 'The rows of a statement and how each matched' })
  @ApiEnvelopedResponses({ 200: statementRowsSchema })
  async rows(@Param() p: RefParamDto, @Query() q: StatementRowsDto) {
    const page = await this.statements.rows(p.ref, q.after, q.limit);
    return { items: page.items.map(toStatementRowView), nextAfter: page.nextAfterRowNo };
  }

  private async views(rows: readonly ExceptionRow[]) {
    const assignees = await this.exceptions.assigneeRefs(rows);
    return rows.map((r) => toExceptionView(r, assignees));
  }

  private async view(row: ExceptionRow) {
    return (await this.views([row]))[0] as ReturnType<typeof toExceptionView>;
  }
}
