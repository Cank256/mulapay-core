/**
 * The approvals workflow (spec 11, maker-checker) for operational changes: rewinding a consumer
 * cursor, changing a feature flag in production, disabling a provider that routes live traffic
 * and removing a routing rule. (Settlement release, reconciliation write-offs and AML decisions
 * have their own approvals from earlier phases; the inbox here lists this table only.)
 *
 * Invariants upheld:
 *  - One pending request per subject and kind: asking twice returns the same request.
 *  - The requester can never decide their own request (`APPROVAL_SELF_DECISION`), and the
 *    controller requires step-up (MFA re-authentication within five minutes) to decide.
 *  - Approving performs the change in the same transaction as the decision, then writes the
 *    audit row last; if the change is no longer valid, nothing commits and the request stays
 *    pending. A rejection changes nothing.
 *  - A decided approval is final (a trigger refuses any edit), and a request left pending past
 *    `APPROVAL_TTL_HOURS` is expired by a sweep and can no longer be approved.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import { markAuditNotApplicable } from '../../../common/context/request-context';
import type { Transaction } from '../../../common/db/database.types';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import {
  decodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../../common/pagination/cursor';
import { approvalsPending, metricRefreshers } from '../../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import { NotificationsService } from '../../notifications/notifications.service';
import { APPROVAL_EXECUTORS, type ApprovalExecutor } from './approval-executor';
import {
  ApprovalsRepository,
  type ApprovalRow,
  type ApprovalWithRefs,
  type DecisionRow,
} from './approvals.repository';

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

export interface ApprovalDetail {
  readonly approval: ApprovalWithRefs;
  readonly decisions: Array<{ row: DecisionRow; approverRef: string }>;
}

export interface RequestApprovalInput {
  readonly kind: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly reason: string;
}

@Injectable()
export class ApprovalsService {
  private readonly executors: Map<string, ApprovalExecutor>;

  constructor(
    private readonly repository: ApprovalsRepository,
    private readonly notifications: NotificationsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(APPROVAL_EXECUTORS) executors: readonly ApprovalExecutor[],
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {
    this.executors = new Map(executors.map((e) => [e.kind, e]));
    metricRefreshers.set('approvals_pending', async () => {
      approvalsPending.set(await this.repository.pendingCount());
    });
  }

  /**
   * Asks for a change to be approved, inside the caller's transaction. Returns the pending
   * request, `created: false` when the same request was already waiting.
   */
  async request(
    tx: Transaction,
    input: RequestApprovalInput,
    staff: Staff
  ): Promise<{ approval: ApprovalRow; created: boolean }> {
    const executor = this.executors.get(input.kind);
    if (!executor) {
      throw new AppError('APPROVAL_INVALID', {
        messageParams: { reason: 'unknown_kind' },
        details: { reason: 'unknown_kind' },
      });
    }
    const payload = await executor.prepare(tx, input.payload);
    const now = this.clock.now();
    const inserted = await this.repository.insertIfNew(tx, {
      id: uuidv7(now),
      ref: publicId('approval', now),
      kind: input.kind,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      payload,
      reason: input.reason,
      requestedBy: staff.userId,
      requestedAt: now,
      requiredApprovals: 1,
      expiresAt: new Date(now.getTime() + this.config.APPROVAL_TTL_HOURS * 3_600_000),
      createdAt: now,
    });
    if (!inserted) {
      const existing = await this.repository.findPending(
        tx,
        input.kind,
        input.resourceType,
        input.resourceId
      );
      if (!existing) throw new Error('approval conflict without a pending approval');
      // Asking again changed nothing, so there is nothing to audit.
      markAuditNotApplicable();
      return { approval: existing, created: false };
    }
    await this.notifications.notify(tx, {
      templateCode: 'approval.requested',
      audience: { kind: 'staff', permission: 'ops:approve' },
      resourceKey: inserted.ref,
      sourceKey: `approval.requested:${inserted.ref}`,
      variables: { approval_ref: inserted.ref, kind: inserted.kind },
    });
    await this.audit.record(tx, {
      action: 'approval.requested',
      resourceType: 'approval',
      resourceId: inserted.ref,
      after: {
        kind: inserted.kind,
        subject: `${inserted.resourceType}:${inserted.resourceId}`,
        expiresAt: inserted.expiresAt.toISOString(),
      },
    });
    return { approval: inserted, created: true };
  }

  /** Approves or rejects. Approving carries the change out; see the class comment. */
  async decide(
    ref: string,
    decision: 'approve' | 'reject',
    note: string | undefined,
    staff: Staff
  ): Promise<ApprovalDetail> {
    await this.unitOfWork.run(async (tx) => {
      const approval = await this.repository.lockByRef(tx, ref);
      if (!approval) throw new AppError('NOT_FOUND');
      const now = this.clock.now();
      if (approval.status !== 'pending' || approval.expiresAt.getTime() <= now.getTime()) {
        throw new AppError('APPROVAL_NOT_PENDING', {
          details: { status: approval.status === 'pending' ? 'expired' : approval.status },
        });
      }
      if (approval.requestedBy === staff.userId) throw new AppError('APPROVAL_SELF_DECISION');
      await this.repository.insertDecision(tx, {
        id: uuidv7(now),
        approvalId: approval.id,
        approverId: staff.userId,
        decision,
        note: note ?? null,
        decidedAt: now,
      });
      let result: Record<string, unknown> = {};
      if (decision === 'reject') {
        await this.repository.update(tx, approval.id, { status: 'rejected', decidedAt: now });
      } else {
        const approvedCount = await this.repository.approveCount(tx, approval.id);
        if (approvedCount < approval.requiredApprovals) return;
        const executor = this.executors.get(approval.kind);
        if (!executor) throw new Error(`no executor for approval kind ${approval.kind}`);
        result = await executor.execute(tx, approval, { approver: staff, now });
        await this.repository.update(tx, approval.id, {
          status: 'approved',
          decidedAt: now,
          executedAt: now,
        });
      }
      await this.notifications.notify(tx, {
        templateCode: 'approval.decided',
        audience: { kind: 'user', userId: approval.requestedBy },
        resourceKey: approval.ref,
        sourceKey: `approval.decided:${approval.ref}`,
        variables: {
          approval_ref: approval.ref,
          decision: decision === 'approve' ? 'approved' : 'rejected',
        },
      });
      await this.audit.record(tx, {
        action: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
        resourceType: 'approval',
        resourceId: approval.ref,
        before: { status: 'pending' },
        after: {
          status: decision === 'approve' ? 'approved' : 'rejected',
          kind: approval.kind,
          requestedBy: approval.requestedBy,
          note: note ?? null,
          ...(decision === 'approve' ? { result } : {}),
        },
      });
    });
    return this.get(ref);
  }

  /** Marks pending requests past their time as expired. Returns how many. */
  async expireOverdue(): Promise<number> {
    const now = this.clock.now();
    const overdue = await this.repository.expiredPending(now, 200);
    let expired = 0;
    for (const { ref } of overdue) {
      const done = await this.unitOfWork.run(async (tx) => {
        const approval = await this.repository.lockByRef(tx, ref);
        if (
          !approval ||
          approval.status !== 'pending' ||
          approval.expiresAt.getTime() > now.getTime()
        ) {
          return false;
        }
        await this.repository.update(tx, approval.id, { status: 'expired' });
        await this.audit.record(tx, {
          action: 'approval.expired',
          resourceType: 'approval',
          resourceId: approval.ref,
          before: { status: 'pending' },
          after: { status: 'expired', kind: approval.kind },
          actor: { type: 'job', id: 'approvals-expiry', label: 'approval expiry sweep' },
        });
        return true;
      });
      if (done) expired += 1;
    }
    return expired;
  }

  async get(ref: string): Promise<ApprovalDetail> {
    const approval = await this.repository.findByRef(ref);
    if (!approval) throw new AppError('NOT_FOUND');
    return { approval, decisions: await this.repository.decisions(approval.row.id) };
  }

  async list(query: {
    status?: string;
    kind?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ApprovalWithRefs>> {
    const fingerprint = filterFingerprint({ status: query.status, kind: query.kind });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.repository.list({ ...query, after });
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.requestedAt,
      id: r.row.ref,
    }));
  }
}
