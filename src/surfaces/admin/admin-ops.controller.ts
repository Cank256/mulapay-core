/**
 * `/admin/v1/ops` (spec 7.3): the operations back office. Read routes need `ops:read`; the
 * operations that change anything need `ops:manage` and step-up, and are audited. Changes that
 * could hurt the platform (rewinding the consumer cursor, changing a feature flag in production)
 * answer 202 with an approval request and change nothing until a second person approves it.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import type { Clock } from '../../common/clock/clock';
import { Inject } from '@nestjs/common';
import { CLOCK } from '../../common/tokens';
import { ApprovalsService } from '../../modules/operations/approvals/approvals.service';
import { ConsumerCursorsService } from '../../modules/operations/consumer-cursors.service';
import { FeatureFlagsService } from '../../modules/operations/feature-flags.service';
import { MaintenanceService } from '../../modules/operations/maintenance.service';
import { OpsOverviewService } from '../../modules/operations/ops-overview.service';
import { QueueOpsService } from '../../modules/operations/queue-ops.service';
import {
  approvalDetailSchema,
  approvalPageSchema,
  approvalRequiredSchema,
  cursorsSchema,
  flagSchema,
  flagsSchema,
  maintenanceSchema,
  overviewSchema,
  queueSchema,
  queuesSchema,
  retriedSchema,
  stuckPageSchema,
  suspenseSchema,
  toApproval,
  toApprovalDetail,
  toCursor,
  toFlag,
  toMaintenance,
  toQueue,
  toStuck,
  toSuspense,
} from '../../modules/operations/ops.views';
import {
  approvalListSchema,
  changeFlagSchema,
  createFlagSchema,
  cursorParamSchema,
  decideApprovalSchema,
  flagParamSchema,
  maintenanceBodySchema,
  queueParamSchema,
  retryFailedSchema,
  rewindSchema,
  stuckListSchema,
} from '../shared/support.schemas';
import { refParamSchema } from '../shared/schemas';

class QueueParamDto extends createZodDto(queueParamSchema) {}
class RetryDto extends createZodDto(retryFailedSchema) {}
class CursorParamDto extends createZodDto(cursorParamSchema) {}
class RewindDto extends createZodDto(rewindSchema) {}
class StuckDto extends createZodDto(stuckListSchema) {}
class FlagParamDto extends createZodDto(flagParamSchema) {}
class CreateFlagDto extends createZodDto(createFlagSchema) {}
class ChangeFlagDto extends createZodDto(changeFlagSchema) {}
class MaintenanceDto extends createZodDto(maintenanceBodySchema) {}
class ApprovalListDto extends createZodDto(approvalListSchema) {}
class RefDto extends createZodDto(refParamSchema) {}
class DecideDto extends createZodDto(decideApprovalSchema) {}

const staffOf = (s: StaffPrincipal) => ({ userId: s.userId, userRef: s.userRef });

@ApiTags('Operations')
@Controller('ops')
export class AdminOpsController {
  constructor(
    private readonly overview: OpsOverviewService,
    private readonly queues: QueueOpsService,
    private readonly cursors: ConsumerCursorsService,
    private readonly flags: FeatureFlagsService,
    private readonly maintenance: MaintenanceService,
    private readonly approvals: ApprovalsService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Get('overview')
  @RequirePermission('ops:read')
  @ApiOperation({
    summary:
      'The first screen: queues, consumer, stuck transactions, suspense, incidents, approvals',
    description: 'Volume comes from the daily rollups, never from the transactions.',
  })
  @ApiEnvelopedResponses({ 200: overviewSchema })
  async getOverview() {
    const o = await this.overview.overview();
    return {
      generatedAt: o.generatedAt.toISOString(),
      maintenance: toMaintenance(o.maintenance),
      queues: o.queues.map(toQueue),
      cursors: o.cursors.map(toCursor),
      stuckTransactions: {
        thresholdMinutes: o.stuckTransactions.thresholdMinutes,
        count: o.stuckTransactions.count,
        oldest: o.stuckTransactions.oldest?.toISOString() ?? null,
      },
      suspense: toSuspense(o.suspense),
      openIncidents: o.openIncidents,
      pendingApprovals: o.pendingApprovals,
      breachedComplaints: o.breachedComplaints,
      notificationBacklog: o.notificationBacklog,
      providers: o.providers.map((p) => ({
        provider: p.provider,
        enabled: p.enabled,
        health: p.health,
      })),
      today: {
        day: o.today.day,
        totals: o.today.totals.map((t) => ({
          ...t,
          paymentMinor: t.paymentMinor.toString(),
          refundMinor: t.refundMinor.toString(),
          payoutMinor: t.payoutMinor.toString(),
        })),
      },
    };
  }

  @Get('queues')
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'Every queue: waiting, active, delayed, failed, paused, oldest wait' })
  @ApiEnvelopedResponses({ 200: queuesSchema })
  async listQueues() {
    return { items: (await this.queues.list(this.clock.now())).map(toQueue) };
  }

  @Post('queues/:name/retry-failed')
  @HttpCode(200)
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('queue.failed_retried', 'queue')
  @ApiOperation({
    summary: 'Retry failed jobs of a queue',
    description: 'Jobs are idempotent, so retrying is safe. At most 1,000 per call.',
  })
  @ApiEnvelopedResponses({ 200: retriedSchema })
  retry(@Param() p: QueueParamDto, @Body() body: RetryDto) {
    return this.queues.retryFailed(p.name, body.limit);
  }

  @Post('queues/:name/pause')
  @HttpCode(200)
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('queue.paused', 'queue')
  @ApiOperation({ summary: 'Pause a queue: running jobs finish, no new ones start' })
  @ApiEnvelopedResponses({ 200: queueSchema })
  async pause(@Param() p: QueueParamDto) {
    await this.queues.pause(p.name);
    return toQueue(await this.queues.view(p.name, this.clock.now()));
  }

  @Post('queues/:name/resume')
  @HttpCode(200)
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('queue.resumed', 'queue')
  @ApiOperation({ summary: 'Resume a paused queue' })
  @ApiEnvelopedResponses({ 200: queueSchema })
  async resume(@Param() p: QueueParamDto) {
    await this.queues.resume(p.name);
    return toQueue(await this.queues.view(p.name, this.clock.now()));
  }

  @Get('consumer-cursors')
  @RequirePermission('ops:read')
  @ApiOperation({
    summary: 'The gateway event consumer’s cursor, heartbeat and lag',
    description:
      'Lag is how old the oldest event after the cursor is (null where the gateway stream cannot be read).',
  })
  @ApiEnvelopedResponses({ 200: cursorsSchema })
  async listCursors() {
    return { items: (await this.cursors.list()).map(toCursor) };
  }

  @Post('consumer-cursors/:name/rewind')
  @HttpCode(202)
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('consumer_cursor.rewind_requested', 'consumer_cursor')
  @ApiOperation({
    summary: 'Ask for the cursor to be moved back',
    description:
      'Always needs a second person (`approval required`): answers 202 and changes nothing until approved. The cursor can only move backwards.',
  })
  @ApiEnvelopedResponses({ 202: approvalRequiredSchema })
  async rewind(
    @Param() p: CursorParamDto,
    @Body() body: RewindDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    const { approval } = await this.cursors.requestRewind(
      p.name,
      body.position,
      body.reason,
      staffOf(staff)
    );
    return {
      approvalRequired: true as const,
      approval: toApproval({ row: approval, requestedByRef: staff.userRef }),
    };
  }

  @Get('stuck-transactions')
  @RequirePermission('ops:read')
  @ApiOperation({
    summary: 'Transactions processing for too long, oldest first',
    description: 'The default threshold is `OPS_STUCK_TXN_MINUTES`.',
  })
  @ApiEnvelopedResponses({ 200: stuckPageSchema })
  async stuck(@Query() q: StuckDto) {
    const now = this.clock.now();
    const page = await this.overview.stuckTransactions({
      olderThanMinutes: q.olderThanMinutes,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: page.items.map((s) => toStuck(s, now)), nextCursor: page.nextCursor };
  }

  @Get('suspense')
  @RequirePermission('ops:read')
  @ApiOperation({
    summary: 'Non-zero suspense balances (debit positive), per environment and currency',
  })
  @ApiEnvelopedResponses({ 200: suspenseSchema })
  async suspense() {
    return { items: toSuspense(await this.overview.suspense()) };
  }

  @Get('feature-flags')
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'Feature flags' })
  @ApiEnvelopedResponses({ 200: flagsSchema })
  async listFlags() {
    return { items: (await this.flags.list()).map(toFlag) };
  }

  @Post('feature-flags')
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('feature_flag.created', 'feature_flag')
  @ApiOperation({ summary: 'Register a flag (it starts off)' })
  @ApiEnvelopedResponses({ 201: flagSchema })
  async createFlag(@Body() body: CreateFlagDto, @CurrentStaff() staff: StaffPrincipal) {
    return toFlag(await this.flags.create(body, staffOf(staff)));
  }

  @Patch('feature-flags/:key')
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('feature_flag.changed', 'feature_flag')
  @ApiOperation({
    summary: 'Change a flag',
    description:
      'In production (`OPS_FLAG_CHANGE_APPROVAL`) this answers 202 with an approval request and changes nothing until a second person approves; give a `reason`.',
  })
  @ApiEnvelopedResponses({ 200: flagSchema, 202: approvalRequiredSchema })
  async changeFlag(
    @Param() p: FlagParamDto,
    @Body() body: ChangeFlagDto,
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const result = await this.flags.change(
      p.key,
      {
        enabled: body.enabled,
        rolloutPercent: body.rolloutPercent,
        merchantAllowlistRefs: body.merchantAllowlist,
      },
      body.reason,
      staffOf(staff)
    );
    if (result.kind === 'applied') return toFlag(result.value);
    void reply.status(202);
    return {
      approvalRequired: true as const,
      approval: toApproval({ row: result.approval, requestedByRef: staff.userRef }),
    };
  }

  @Get('maintenance-mode')
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'Whether maintenance mode is on' })
  @ApiEnvelopedResponses({ 200: maintenanceSchema })
  async getMaintenance() {
    return toMaintenance(await this.maintenance.status());
  }

  @Post('maintenance-mode')
  @HttpCode(200)
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('maintenance.changed', 'maintenance')
  @ApiOperation({
    summary: 'Turn maintenance mode on or off',
    description:
      'While on, every write on every surface answers 503 with `Retry-After`; reads keep working. Signing in, and this route, stay open. Background jobs keep running.',
  })
  @ApiEnvelopedResponses({ 200: maintenanceSchema })
  async setMaintenance(@Body() body: MaintenanceDto, @CurrentStaff() staff: StaffPrincipal) {
    return toMaintenance(await this.maintenance.set(body, staffOf(staff)));
  }

  @Get('approvals')
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'The approvals inbox, newest first' })
  @ApiEnvelopedResponses({ 200: approvalPageSchema })
  async listApprovals(@Query() q: ApprovalListDto) {
    const page = await this.approvals.list({
      status: q.status,
      kind: q.kind,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: page.items.map(toApproval), nextCursor: page.nextCursor };
  }

  @Get('approvals/:ref')
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'One approval request and the decisions on it' })
  @ApiEnvelopedResponses({ 200: approvalDetailSchema })
  async getApproval(@Param() p: RefDto) {
    return toApprovalDetail(await this.approvals.get(p.ref));
  }

  @Post('approvals/:ref/approve')
  @HttpCode(200)
  @RequirePermission('ops:approve')
  @RequiresStepUp()
  @Audited('approval.approved', 'approval')
  @ApiOperation({
    summary: 'Approve a request, which carries out the change',
    description: 'Never your own request. The change and the decision commit together.',
  })
  @ApiEnvelopedResponses({ 200: approvalDetailSchema })
  async approve(
    @Param() p: RefDto,
    @Body() body: DecideDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toApprovalDetail(
      await this.approvals.decide(p.ref, 'approve', body.note, staffOf(staff))
    );
  }

  @Post('approvals/:ref/reject')
  @HttpCode(200)
  @RequirePermission('ops:approve')
  @RequiresStepUp()
  @Audited('approval.rejected', 'approval')
  @ApiOperation({ summary: 'Reject a request; nothing changes' })
  @ApiEnvelopedResponses({ 200: approvalDetailSchema })
  async reject(@Param() p: RefDto, @Body() body: DecideDto, @CurrentStaff() staff: StaffPrincipal) {
    return toApprovalDetail(
      await this.approvals.decide(p.ref, 'reject', body.note, staffOf(staff))
    );
  }
}
