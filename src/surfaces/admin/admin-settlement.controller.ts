/**
 * `/admin/v1/settlement/*` (spec 7.3): cycles, payables, batches and the approval and release
 * workflow, plus the merchant settlement destination and rolling reserve the spec's
 * "+ CRUD" implies. Controllers stay thin: authorise, validate, call the service, shape.
 *
 * Maker-checker: whoever submits a batch cannot approve it. Approving and releasing need a
 * recent step-up. Release is asynchronous: it answers with the batch in `releasing`.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
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
import { RollingReserveService } from '../../modules/settlement/rolling-reserve.service';
import { SettlementBatchService } from '../../modules/settlement/settlement-batch.service';
import {
  SettlementBatchesRepository,
  type BatchRow,
} from '../../modules/settlement/settlement-batches.repository';
import { SettlementCyclesRepository } from '../../modules/settlement/settlement-cycles.repository';
import { SettlementCyclesService } from '../../modules/settlement/settlement-cycles.service';
import { SettlementDestinationsService } from '../../modules/settlement/settlement-destinations.service';
import { SettlementReleaseService } from '../../modules/settlement/settlement-release.service';
import { SettlementReportsService } from '../../modules/settlement/settlement-reports.service';
import { SettlementRunService } from '../../modules/settlement/settlement-run.service';
import {
  cycleSchema,
  settlementItemPageSchema,
  toCycleView,
  toSettlementItemView,
  toSettlementView,
} from '../../modules/settlement/settlement.views';
import {
  adminBatchPageSchema,
  adminBatchSchema,
  assignMerchantSchema,
  cancelBatchSchema,
  cycleBodySchema,
  cyclePatchSchema,
  destinationBodySchema,
  destinationSchema,
  listBatchesSchema,
  payablesQuerySchema,
  payablesSchema,
  rollingReserveBodySchema,
  rollingReserveSchema,
  runCycleSchema,
  settlementItemsQuerySchema,
  settlementRunSchema,
  statementSchema,
} from '../shared/settlement.schemas';
import { refParamSchema, refSchema } from '../shared/schemas';

class CycleBodyDto extends createZodDto(cycleBodySchema) {}
class CyclePatchDto extends createZodDto(cyclePatchSchema) {}
class AssignMerchantDto extends createZodDto(assignMerchantSchema) {}
class RunCycleDto extends createZodDto(runCycleSchema) {}
class PayablesQueryDto extends createZodDto(payablesQuerySchema) {}
class ListBatchesDto extends createZodDto(listBatchesSchema) {}
class RefParamDto extends createZodDto(refParamSchema) {}
class ItemsQueryDto extends createZodDto(settlementItemsQuerySchema) {}
class CancelBatchDto extends createZodDto(cancelBatchSchema) {}
class DestinationBodyDto extends createZodDto(destinationBodySchema) {}
class MerchantQueryDto extends createZodDto(z.strictObject({ merchant: refSchema })) {}
class RollingReserveBodyDto extends createZodDto(rollingReserveBodySchema) {}

const emptyBody = z.strictObject({});
class EmptyBodyDto extends createZodDto(emptyBody) {}

@ApiTags('Settlement')
@Controller('settlement')
export class AdminSettlementController {
  constructor(
    private readonly cycles: SettlementCyclesService,
    private readonly cycleRepo: SettlementCyclesRepository,
    private readonly runs: SettlementRunService,
    private readonly batches: SettlementBatchService,
    private readonly batchRepo: SettlementBatchesRepository,
    private readonly release: SettlementReleaseService,
    private readonly reports: SettlementReportsService,
    private readonly destinations: SettlementDestinationsService,
    private readonly reserve: RollingReserveService
  ) {}

  // ---- cycles ----
  @Get('cycles')
  @RequirePermission('settlement:read')
  @ApiOperation({ summary: 'Settlement cycles' })
  @ApiEnvelopedResponses({ 200: z.object({ items: z.array(cycleSchema) }) })
  async listCycles() {
    return { items: (await this.cycles.list()).map(toCycleView) };
  }

  @Post('cycles')
  @RequirePermission('settlement:prepare')
  @Audited('settlement.cycle.created', 'settlement_cycle')
  @ApiOperation({ summary: 'Create a settlement cycle' })
  @ApiEnvelopedResponses({ 201: cycleSchema })
  async createCycle(@Body() body: CycleBodyDto, @CurrentStaff() staff: StaffPrincipal) {
    return toCycleView(await this.cycles.create(body, staff.userId));
  }

  @Post('cycles/assign')
  @HttpCode(200)
  @RequirePermission('settlement:prepare')
  @Audited('settlement.cycle.merchant_assigned', 'merchant')
  @ApiOperation({ summary: 'Put a merchant on a cycle, or take it off with `cycle: null`' })
  @ApiEnvelopedResponses({ 200: z.object({ merchant: z.string(), cycle: z.string().nullable() }) })
  async assign(@Body() body: AssignMerchantDto) {
    await this.cycles.assignMerchant(body.merchant, body.cycle);
    return { merchant: body.merchant, cycle: body.cycle };
  }

  @Patch('cycles/:ref')
  @RequirePermission('settlement:prepare')
  @Audited('settlement.cycle.updated', 'settlement_cycle')
  @ApiOperation({ summary: 'Change a cycle, or deactivate it' })
  @ApiEnvelopedResponses({ 200: cycleSchema })
  async updateCycle(@Param() p: RefParamDto, @Body() body: CyclePatchDto) {
    return toCycleView(await this.cycles.update(p.ref, body));
  }

  // ---- payables and runs ----
  @Get('payables')
  @RequirePermission('settlement:read')
  @ApiOperation({
    summary: 'What each eligible merchant would be paid if the cycle ran now',
    description: 'Read-only: nothing is created and nothing is posted.',
  })
  @ApiEnvelopedResponses({ 200: payablesSchema })
  async payables(@Query() q: PayablesQueryDto) {
    const preview = await this.runs.preview(q.cycle, { afterId: q.after, limit: q.limit });
    return {
      periodEnd: preview.periodEnd.toISOString(),
      items: preview.items.map((i) => ({
        merchant: i.merchant.ref,
        decision: i.decision,
        periodStart: i.periodStart?.toISOString() ?? null,
        grossMinor: i.amounts?.grossMinor.toString() ?? null,
        refundMinor: i.amounts?.refundMinor.toString() ?? null,
        feeMinor: i.amounts?.feeMinor.toString() ?? null,
        reserveMinor: i.amounts?.reserveMinor.toString() ?? null,
        reserveReleaseMinor: i.amounts?.reserveReleaseMinor.toString() ?? null,
        holdMinor: i.amounts
          ? (i.amounts.disputeHoldMinor + i.amounts.amlHoldMinor).toString()
          : null,
        shortfallMinor: i.amounts?.shortfallMinor.toString() ?? null,
        netMinor: i.amounts?.netMinor.toString() ?? null,
      })),
      nextAfter: preview.nextAfterId,
    };
  }

  @Post('batches')
  @HttpCode(200)
  @RequirePermission('settlement:prepare')
  @Audited('settlement.run.requested', 'settlement_run')
  @ApiOperation({
    summary: 'Run a cycle now',
    description:
      'Creates draft batches for the period that ended at the last cutoff. Running the same period again creates nothing.',
  })
  @ApiEnvelopedResponses({ 200: settlementRunSchema })
  async runCycle(@Body() body: RunCycleDto, @CurrentStaff() staff: StaffPrincipal) {
    const result = await this.runs.runCycle(body.cycle, { triggeredBy: `user:${staff.userId}` });
    if (result.outcome !== 'completed') markAuditNotApplicable();
    const run = 'run' in result ? result.run : undefined;
    return {
      id: run?.ref ?? '',
      outcome: result.outcome,
      periodEnd: run?.periodEnd.toISOString() ?? null,
      status: run?.status ?? null,
      merchantsConsidered: run?.merchantsConsidered ?? null,
      batchesCreated: run?.batchesCreated ?? null,
      rolledOver: run?.rolledOver ?? null,
      failedMerchants: run?.failedMerchants ?? null,
    };
  }

  // ---- batches ----
  @Get('batches')
  @RequirePermission('settlement:read')
  @ApiOperation({ summary: 'Settlement batches, newest first' })
  @ApiEnvelopedResponses({ 200: adminBatchPageSchema })
  async listBatches(@Query() q: ListBatchesDto) {
    const merchantId = q.merchant ? await this.merchantId(q.merchant) : undefined;
    const cycle = q.cycle ? await this.cycleRepo.findByRef(q.cycle) : undefined;
    const page = await this.batches.list({
      merchantId,
      cycleId: cycle?.id,
      status: q.status,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: await this.describe(page.items), nextCursor: page.nextCursor };
  }

  @Get('batches/:ref')
  @RequirePermission('settlement:read')
  @ApiOperation({ summary: 'One batch' })
  @ApiEnvelopedResponses({ 200: adminBatchSchema })
  async getBatch(@Param() p: RefParamDto) {
    return (await this.describe([await this.batches.get(p.ref)]))[0];
  }

  @Get('batches/:ref/items')
  @RequirePermission('settlement:read')
  @ApiOperation({ summary: 'The payments, refunds and reserve lines behind a batch' })
  @ApiEnvelopedResponses({ 200: settlementItemPageSchema })
  async items(@Param() p: RefParamDto, @Query() q: ItemsQueryDto) {
    const page = await this.batches.items(await this.batches.get(p.ref), q);
    return { items: page.items.map(toSettlementItemView), nextCursor: page.nextCursor };
  }

  @Get('batches/:ref/statement')
  @RequirePermission('settlement:read')
  @ApiOperation({ summary: 'The itemised statement, with ledger and reconciliation references' })
  @ApiEnvelopedResponses({ 200: statementSchema })
  async statement(@Param() p: RefParamDto) {
    return this.reports.statement(await this.batches.get(p.ref), 'staff');
  }

  @Post('batches/:ref/submit')
  @HttpCode(200)
  @RequirePermission('settlement:prepare')
  @Audited('settlement.batch.pending_approval', 'settlement_batch')
  @ApiOperation({ summary: 'Submit a draft batch for approval' })
  @ApiEnvelopedResponses({ 200: adminBatchSchema })
  async submit(
    @Param() p: RefParamDto,
    @Body() _body: EmptyBodyDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return (await this.describe([await this.batches.submit(p.ref, staff.userId)]))[0];
  }

  @Post('batches/:ref/approve')
  @HttpCode(200)
  @RequirePermission('settlement:approve')
  @RequiresStepUp()
  @Audited('settlement.batch.approved', 'settlement_batch')
  @ApiOperation({ summary: 'Approve a batch. Never the person who submitted it' })
  @ApiEnvelopedResponses({ 200: adminBatchSchema })
  async approve(
    @Param() p: RefParamDto,
    @Body() _body: EmptyBodyDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return (await this.describe([await this.batches.approve(p.ref, staff.userId)]))[0];
  }

  @Post('batches/:ref/release')
  @HttpCode(200)
  @RequirePermission('settlement:release')
  @RequiresStepUp()
  @Audited('settlement.batch.releasing', 'settlement_batch')
  @ApiOperation({
    summary: 'Release an approved batch to the merchant',
    description:
      'Creates the payout and holds the funds, then the worker sends it. Asking again returns the same releasing batch.',
  })
  @ApiEnvelopedResponses({ 200: adminBatchSchema })
  async releaseBatch(
    @Param() p: RefParamDto,
    @Body() _body: EmptyBodyDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    const { batch } = await this.release.release(p.ref, staff.userId);
    return (await this.describe([batch]))[0];
  }

  @Post('batches/:ref/cancel')
  @HttpCode(200)
  @RequirePermission('settlement:prepare')
  @Audited('settlement.batch.cancelled', 'settlement_batch')
  @ApiOperation({ summary: 'Cancel a batch that has not been released' })
  @ApiEnvelopedResponses({ 200: adminBatchSchema })
  async cancel(
    @Param() p: RefParamDto,
    @Body() body: CancelBatchDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return (await this.describe([await this.batches.cancel(p.ref, staff.userId, body.reason)]))[0];
  }

  // ---- destinations and reserve ----
  @Get('destinations')
  @RequirePermission('settlement:read')
  @ApiOperation({ summary: 'A merchant’s settlement destinations, newest first (masked)' })
  @ApiEnvelopedResponses({ 200: z.object({ items: z.array(destinationSchema) }) })
  async listDestinations(@Query() q: MerchantQueryDto) {
    const rows = await this.destinations.listForMerchant(q.merchant);
    return {
      items: rows.map((d) => ({
        id: d.ref,
        currency: d.currency,
        provider: d.provider,
        display: d.display,
        status: d.status,
      })),
    };
  }

  @Put('destinations')
  @RequirePermission('settlement:prepare')
  @RequiresStepUp()
  @Audited('settlement.destination.set', 'settlement_destination')
  @ApiOperation({ summary: 'Set the merchant’s settlement destination (replaces the active one)' })
  @ApiEnvelopedResponses({ 200: destinationSchema })
  async setDestination(@Body() body: DestinationBodyDto, @CurrentStaff() staff: StaffPrincipal) {
    const d = await this.destinations.set(body.merchant, body, staff.userId);
    return {
      id: d.ref,
      currency: d.currency,
      provider: d.provider,
      display: d.display,
      status: d.status,
    };
  }

  @Put('rolling-reserve')
  @RequirePermission('settlement:prepare')
  @Audited('settlement.rolling_reserve.set', 'merchant')
  @ApiOperation({ summary: 'Set a merchant’s rolling reserve (basis points and hold days)' })
  @ApiEnvelopedResponses({ 200: rollingReserveSchema })
  async setReserve(@Body() body: RollingReserveBodyDto, @CurrentStaff() staff: StaffPrincipal) {
    return this.reserve.set(body.merchant, body, staff.userId);
  }

  private async merchantId(ref: string): Promise<string> {
    const refs = await this.batchRepo.merchantIdByRef(ref);
    if (!refs) throw new AppError('NOT_FOUND');
    return refs;
  }

  private async describe(rows: readonly BatchRow[]) {
    const refs = await this.batchRepo.refsFor(rows);
    return rows.map((row) => ({
      ...toSettlementView(row, null),
      merchant: refs.merchants.get(row.merchantId) ?? '',
      cycle: refs.cycles.get(row.cycleId) ?? '',
      provider: row.provider,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      failureCode: row.failureCode,
    }));
  }
}
