/**
 * Complaints (spec 6.14): merchant and customer complaints with a category-driven SLA, a
 * message thread with internal-only notes, an optional transaction, assignment, escalation,
 * resolution, SLA breach detection and notifications.
 *
 * Invariants upheld, each change in one transaction with its audit row last:
 *  - The SLA deadline is `created_at + category.sla_hours` and never changes (a trigger refuses it).
 *  - A merchant sees only its own complaints that are not customer-sourced, and never an internal
 *    note. Another merchant's complaint is "not found", the same answer as a missing one.
 *  - A transaction named on a complaint belongs to the merchant that files it.
 *  - The status moves by `complaint-rules.ts` and the database trigger; closed is final.
 *  - A breach is recorded once, at the deadline, by the minute sweep or at resolution if the
 *    sweep had not seen it yet. Staff are told through a mandatory notification (once, keyed by
 *    complaint) and the complaint appears on the breach queue.
 *  - A customer's contact is stored encrypted and is shown to staff only through its own audited
 *    route; it is never in a list, a notification or a log.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import {
  complaintSlaBreaches,
  complaintsOpen,
  metricRefreshers,
} from '../../common/telemetry/metrics';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { AmlStaffDirectory } from '../aml/aml-staff.directory';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { NotificationsService } from '../notifications/notifications.service';
import {
  isOverdue,
  nextStatus,
  resolvedLate,
  slaDueAt,
  type ComplaintAction,
  type ComplaintStatus,
} from './domain/complaint-rules';
import {
  ComplaintsRepository,
  type ComplaintRow,
  type ComplaintWithRefs,
  type MessageRow,
} from './complaints.repository';

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}
interface MerchantActor {
  readonly scope: MerchantScope;
  readonly userId: string;
}

export interface FileComplaintInput {
  readonly category: string;
  readonly subject: string;
  readonly description: string;
  readonly transactionRef?: string;
  readonly priority?: 'low' | 'normal' | 'high' | 'urgent';
}
export interface RecordComplaintInput extends FileComplaintInput {
  readonly source: 'merchant' | 'customer' | 'admin';
  readonly merchantRef?: string;
  /** A customer's phone or email. Stored encrypted. */
  readonly customerContact?: string;
}
export interface ListComplaintsQuery {
  readonly status?: ComplaintStatus;
  readonly category?: string;
  readonly priority?: string;
  readonly source?: string;
  readonly merchantRef?: string;
  readonly assignedToRef?: string;
  readonly unassigned?: boolean;
  readonly breached?: boolean;
  readonly limit: number;
  readonly cursor?: string;
}
export interface ComplaintDetail {
  readonly complaint: ComplaintWithRefs;
  readonly messages: Array<{ row: MessageRow; authorRef: string | null }>;
}

const SWEEP_BATCH = 200;

@Injectable()
export class ComplaintsService {
  constructor(
    private readonly repository: ComplaintsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly staffDirectory: AmlStaffDirectory,
    private readonly notifications: NotificationsService,
    private readonly encryption: FieldEncryption,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    metricRefreshers.set('complaints_open', () => this.refreshGauge());
  }

  categories() {
    return this.repository.listCategories(true);
  }

  /** A merchant files a complaint about its own account or one of its transactions. */
  async file(actor: MerchantActor, input: FileComplaintInput): Promise<ComplaintWithRefs> {
    const created = await this.unitOfWork.run((tx) =>
      this.create(tx, {
        ...input,
        source: 'merchant',
        merchantId: actor.scope.merchantId,
        createdBy: `user:${actor.userId}`,
        authorId: actor.userId,
      })
    );
    return this.require(created.ref);
  }

  /** Staff record a complaint on someone's behalf (a customer's call, a merchant's email). */
  async record(input: RecordComplaintInput, staff: Staff): Promise<ComplaintWithRefs> {
    if (input.source === 'merchant' && !input.merchantRef) {
      throw new AppError('COMPLAINT_INVALID', {
        messageParams: { reason: 'merchant_required' },
        details: { reason: 'merchant_required' },
      });
    }
    let merchantId: string | undefined;
    if (input.merchantRef) {
      const merchant = await this.merchants.findByRef(input.merchantRef);
      if (!merchant) throw new AppError('NOT_FOUND');
      merchantId = merchant.id;
    }
    const created = await this.unitOfWork.run((tx) =>
      this.create(tx, {
        ...input,
        merchantId,
        createdBy: `user:${staff.userRef}`,
        authorId: staff.userId,
      })
    );
    return this.require(created.ref);
  }

  async get(ref: string, scope?: MerchantScope): Promise<ComplaintDetail> {
    const complaint = await this.repository.findByRef(
      ref,
      scope ? { merchantId: scope.merchantId, merchantOnlyVisible: true } : {}
    );
    if (!complaint) throw new AppError('NOT_FOUND');
    const messages = await this.repository.messages(complaint.row.id, scope === undefined);
    return { complaint, messages };
  }

  async list(query: ListComplaintsQuery, scope?: MerchantScope): Promise<Page<ComplaintWithRefs>> {
    const fingerprint = filterFingerprint({
      merchant: scope?.merchantId ?? query.merchantRef,
      status: query.status,
      category: query.category,
      priority: query.priority,
      source: query.source,
      assignee: query.assignedToRef,
      unassigned: query.unassigned,
      breached: query.breached,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    let merchantId = scope?.merchantId;
    if (!scope && query.merchantRef) {
      const merchant = await this.merchants.findByRef(query.merchantRef);
      if (!merchant) return { items: [], nextCursor: null };
      merchantId = merchant.id;
    }
    const assignedTo = query.assignedToRef
      ? await this.staffDirectory.idOf(query.assignedToRef)
      : undefined;
    const rows = await this.repository.list({
      merchantId,
      merchantOnlyVisible: scope !== undefined,
      status: query.status,
      category: query.category,
      priority: query.priority,
      source: query.source,
      assignedTo,
      unassigned: query.unassigned,
      breached: query.breached,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.createdAt,
      id: r.row.ref,
    }));
  }

  /** The admin queue of breached, unresolved complaints, longest overdue first. */
  async breaches(query: { limit: number; cursor?: string }): Promise<Page<ComplaintWithRefs>> {
    const fingerprint = filterFingerprint({ queue: 'sla_breaches' });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.repository.breachQueue(after, query.limit);
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.slaDueAt,
      id: r.row.ref,
    }));
  }

  /** A message in the thread. Merchants write public messages only; staff may add internal notes. */
  async addMessage(
    ref: string,
    input: { body: string; internal?: boolean; awaitCustomer?: boolean },
    actor: { staff: Staff } | { merchant: MerchantActor }
  ): Promise<ComplaintDetail> {
    const merchantActor = 'merchant' in actor ? actor.merchant : undefined;
    const staff = 'staff' in actor ? actor.staff : undefined;
    if (merchantActor && (input.internal || input.awaitCustomer)) {
      throw new AppError('COMPLAINT_INVALID', {
        messageParams: { reason: 'staff_only' },
        details: { reason: 'staff_only' },
      });
    }
    await this.unitOfWork.run(async (tx) => {
      const complaint = await this.lockVisible(tx, ref, merchantActor?.scope);
      const now = this.clock.now();
      const action: ComplaintAction = merchantActor ? 'reply_merchant' : 'reply_staff';
      let next = this.move(complaint, action);
      if (input.awaitCustomer) {
        next = this.move(complaint, 'await_customer', next);
      }
      await this.repository.insertMessage(tx, {
        id: uuidv7(now),
        complaintId: complaint.id,
        authorType: merchantActor ? 'merchant' : 'admin',
        authorId: merchantActor?.userId ?? staff?.userId ?? null,
        body: input.body,
        internal: input.internal === true,
        createdAt: now,
      });
      const updated =
        next !== complaint.status
          ? await this.repository.update(tx, complaint.id, { status: next })
          : complaint;
      const visibleToMerchant = staff !== undefined && input.internal !== true;
      if (visibleToMerchant && complaint.merchantId && complaint.source !== 'customer') {
        await this.notifications.notify(tx, {
          templateCode: 'complaint.message_received',
          audience: {
            kind: 'merchant',
            merchantId: complaint.merchantId,
            permission: 'complaints:read',
          },
          resourceKey: complaint.ref,
          variables: { complaint_ref: complaint.ref, subject: complaint.subject },
        });
      }
      await this.audit.record(tx, {
        action: 'complaint.message_added',
        resourceType: 'complaint',
        resourceId: complaint.ref,
        merchantId: complaint.merchantId,
        before: { status: complaint.status },
        after: {
          status: updated.status,
          internal: input.internal === true,
          length: input.body.length,
        },
      });
    });
    return this.get(ref, merchantActor?.scope);
  }

  async assign(ref: string, assigneeRef: string, staff: Staff): Promise<ComplaintWithRefs> {
    const assigneeId = await this.staffDirectory.idOf(assigneeRef);
    await this.unitOfWork.run(async (tx) => {
      const complaint = await this.lockOrFail(tx, ref);
      const next = this.move(complaint, 'assign');
      const now = this.clock.now();
      const updated = await this.repository.update(tx, complaint.id, {
        status: next,
        assignedTo: assigneeId,
        assignedAt: now,
      });
      if (assigneeId !== staff.userId) {
        await this.notifications.notify(tx, {
          templateCode: 'complaint.assigned',
          audience: { kind: 'user', userId: assigneeId },
          resourceKey: complaint.ref,
          variables: { complaint_ref: complaint.ref },
        });
      }
      await this.audit.record(tx, {
        action: 'complaint.assigned',
        resourceType: 'complaint',
        resourceId: complaint.ref,
        merchantId: complaint.merchantId,
        before: { status: complaint.status, assignedTo: complaint.assignedTo },
        after: { status: updated.status, assignee: assigneeRef },
      });
    });
    return this.require(ref);
  }

  async escalate(ref: string, reason: string, staff: Staff): Promise<ComplaintWithRefs> {
    await this.unitOfWork.run(async (tx) => {
      const complaint = await this.lockOrFail(tx, ref);
      const next = this.move(complaint, 'escalate');
      const now = this.clock.now();
      const updated = await this.repository.update(tx, complaint.id, {
        status: next,
        escalatedAt: now,
        escalationReason: reason,
      });
      await this.repository.insertMessage(tx, {
        id: uuidv7(now),
        complaintId: complaint.id,
        authorType: 'system',
        authorId: null,
        body: `Escalated by ${staff.userRef}: ${reason}`,
        internal: true,
        createdAt: now,
      });
      await this.notifications.notify(tx, {
        templateCode: 'complaint.escalated',
        audience: { kind: 'staff', permission: 'support:resolve' },
        resourceKey: complaint.ref,
        variables: { complaint_ref: complaint.ref, reason },
      });
      await this.audit.record(tx, {
        action: 'complaint.escalated',
        resourceType: 'complaint',
        resourceId: complaint.ref,
        merchantId: complaint.merchantId,
        before: { status: complaint.status },
        after: { status: updated.status, reason },
      });
    });
    return this.require(ref);
  }

  async resolve(ref: string, resolution: string, staff: Staff): Promise<ComplaintWithRefs> {
    await this.unitOfWork.run(async (tx) => {
      const complaint = await this.lockOrFail(tx, ref);
      const next = this.move(complaint, 'resolve');
      const now = this.clock.now();
      const late = !complaint.breached && resolvedLate(complaint.slaDueAt, now);
      const updated = await this.repository.update(tx, complaint.id, {
        status: next,
        resolution,
        resolvedAt: now,
        resolvedBy: staff.userId,
        ...(late ? { breached: true, breachedAt: complaint.slaDueAt } : {}),
      });
      if (late) complaintSlaBreaches.inc({ priority: complaint.priority });
      if (complaint.merchantId && complaint.source !== 'customer') {
        await this.notifications.notify(tx, {
          templateCode: 'complaint.resolved',
          audience: {
            kind: 'merchant',
            merchantId: complaint.merchantId,
            permission: 'complaints:read',
          },
          resourceKey: complaint.ref,
          variables: { complaint_ref: complaint.ref, subject: complaint.subject },
        });
      }
      await this.audit.record(tx, {
        action: 'complaint.resolved',
        resourceType: 'complaint',
        resourceId: complaint.ref,
        merchantId: complaint.merchantId,
        before: { status: complaint.status, breached: complaint.breached },
        after: { status: updated.status, breached: updated.breached, length: resolution.length },
      });
    });
    return this.require(ref);
  }

  /** The merchant closes its own complaint; a satisfaction score is only taken once it is resolved. */
  async close(
    actor: MerchantActor,
    ref: string,
    input: { satisfactionScore?: number }
  ): Promise<ComplaintDetail> {
    await this.unitOfWork.run(async (tx) => {
      const complaint = await this.lockVisible(tx, ref, actor.scope);
      const next = this.move(complaint, 'close');
      if (input.satisfactionScore !== undefined && complaint.status !== 'resolved') {
        throw new AppError('COMPLAINT_TRANSITION_INVALID', {
          messageParams: { reason: 'not_resolved' },
          details: { reason: 'not_resolved' },
        });
      }
      const now = this.clock.now();
      const late =
        !complaint.breached &&
        complaint.status !== 'resolved' &&
        resolvedLate(complaint.slaDueAt, now);
      const updated = await this.repository.update(tx, complaint.id, {
        status: next,
        closedAt: now,
        satisfactionScore: input.satisfactionScore ?? null,
        ...(late ? { breached: true, breachedAt: complaint.slaDueAt } : {}),
      });
      if (late) complaintSlaBreaches.inc({ priority: complaint.priority });
      await this.audit.record(tx, {
        action: 'complaint.closed',
        resourceType: 'complaint',
        resourceId: complaint.ref,
        merchantId: complaint.merchantId,
        before: { status: complaint.status },
        after: { status: updated.status, satisfactionScore: updated.satisfactionScore },
      });
    });
    return this.get(ref, actor.scope);
  }

  /** The customer's contact, for staff, with an audit row naming who looked. */
  async revealContact(ref: string): Promise<string | null> {
    return this.unitOfWork.run(async (tx) => {
      const complaint = await this.repository.lockByRef(tx, ref);
      if (!complaint) throw new AppError('NOT_FOUND');
      await this.audit.record(tx, {
        action: 'complaint.contact_viewed',
        resourceType: 'complaint',
        resourceId: complaint.ref,
        merchantId: complaint.merchantId,
      });
      return complaint.customerContactEnc
        ? this.encryption.decrypt(complaint.customerContactEnc, contactContext(complaint.id))
        : null;
    });
  }

  /**
   * The minute sweep: marks every unresolved complaint past its deadline as breached and tells
   * staff. Each complaint is handled in its own transaction under its row lock, re-checked, so
   * two workers (or two sweeps) record one breach and send one notification.
   */
  async sweepSla(): Promise<number> {
    const now = this.clock.now();
    const candidates = await this.repository.overdueIds(now, SWEEP_BATCH);
    let breached = 0;
    for (const { ref } of candidates) {
      try {
        const done = await this.unitOfWork.run(async (tx) => {
          const complaint = await this.repository.lockByRef(tx, ref);
          if (!complaint || complaint.breached) return false;
          if (
            !isOverdue(
              { status: complaint.status as ComplaintStatus, slaDueAt: complaint.slaDueAt },
              now
            )
          ) {
            return false;
          }
          await this.repository.update(tx, complaint.id, {
            breached: true,
            breachedAt: complaint.slaDueAt,
            breachNotifiedAt: now,
          });
          const staffAudience = complaint.assignedTo
            ? ({ kind: 'users', userIds: [complaint.assignedTo] } as const)
            : ({ kind: 'staff', permission: 'support:work' } as const);
          const variables = {
            complaint_ref: complaint.ref,
            category: complaint.category,
            due_at: complaint.slaDueAt.toISOString(),
          };
          await this.notifications.notify(tx, {
            templateCode: 'complaint.sla_breached',
            audience: staffAudience,
            resourceKey: complaint.ref,
            sourceKey: `complaint.sla_breached:${complaint.ref}`,
            variables,
          });
          // Supervisors hear of every breach, not only the assignee.
          if (complaint.assignedTo) {
            await this.notifications.notify(tx, {
              templateCode: 'complaint.sla_breached',
              audience: { kind: 'staff', permission: 'support:resolve' },
              resourceKey: complaint.ref,
              sourceKey: `complaint.sla_breached.supervisor:${complaint.ref}`,
              variables,
            });
          }
          complaintSlaBreaches.inc({ priority: complaint.priority });
          await this.audit.record(tx, {
            action: 'complaint.sla_breached',
            resourceType: 'complaint',
            resourceId: complaint.ref,
            merchantId: complaint.merchantId,
            after: { dueAt: complaint.slaDueAt.toISOString(), status: complaint.status },
            actor: { type: 'job', id: 'complaint-sla', label: 'complaint SLA sweep' },
          });
          return true;
        });
        if (done) breached += 1;
      } catch (error) {
        this.logger.error(
          { complaint: ref, err: error instanceof Error ? error.message : 'unknown' },
          'complaint SLA sweep failed for one complaint'
        );
      }
    }
    return breached;
  }

  async refreshGauge(): Promise<void> {
    const counts = await this.repository.openCounts();
    complaintsOpen.reset();
    for (const c of counts) {
      complaintsOpen.set({ priority: c.priority, breached: String(c.breached) }, c.n);
    }
  }

  // -- internals ---------------------------------------------------------------------------

  private async create(
    tx: Transaction,
    input: FileComplaintInput & {
      source: 'merchant' | 'customer' | 'admin';
      merchantId?: string;
      createdBy: string;
      authorId: string;
      customerContact?: string;
    }
  ): Promise<ComplaintRow> {
    const category = await this.repository.category(input.category, tx);
    if (!category || !category.active) {
      throw new AppError('COMPLAINT_INVALID', {
        messageParams: { reason: 'unknown_category' },
        details: { reason: 'unknown_category' },
      });
    }
    let transactionId: string | undefined;
    let merchantId = input.merchantId;
    if (input.transactionRef) {
      const found = merchantId
        ? await this.repository.transactionOf(input.transactionRef, merchantId, tx)
        : await this.repository.anyTransaction(input.transactionRef, tx);
      if (!found) {
        throw new AppError('COMPLAINT_INVALID', {
          messageParams: { reason: 'transaction_not_found' },
          details: { reason: 'transaction_not_found' },
        });
      }
      transactionId = found.id;
      // A customer complaint about a transaction belongs to the merchant that took the payment.
      if (!merchantId && 'merchantId' in found) merchantId = found.merchantId as string;
    }
    if (input.customerContact && !this.encryption.available) {
      throw new AppError('SERVICE_UNAVAILABLE', { cause: new Error('no data encryption key') });
    }
    const now = this.clock.now();
    const id = uuidv7(now);
    const row = await this.repository.insert(tx, {
      id,
      ref: publicId('complaint', now),
      merchantId: merchantId ?? null,
      source: input.source,
      category: category.code,
      subject: input.subject,
      description: input.description,
      transactionId: transactionId ?? null,
      customerContactEnc: input.customerContact
        ? this.encryption.encrypt(input.customerContact, contactContext(id))
        : null,
      priority: input.priority ?? category.defaultPriority,
      slaDueAt: slaDueAt(now, category.slaHours),
      createdBy: input.createdBy,
      createdAt: now,
    });
    await this.notifications.notify(tx, {
      templateCode: 'complaint.created',
      audience: { kind: 'staff', permission: 'support:work' },
      resourceKey: row.ref,
      sourceKey: `complaint.created:${row.ref}`,
      variables: {
        complaint_ref: row.ref,
        category: category.name,
        priority: row.priority,
        due_at: row.slaDueAt.toISOString(),
      },
    });
    await this.audit.record(tx, {
      action: 'complaint.created',
      resourceType: 'complaint',
      resourceId: row.ref,
      merchantId: row.merchantId,
      after: {
        source: row.source,
        category: row.category,
        priority: row.priority,
        slaDueAt: row.slaDueAt.toISOString(),
        transaction: input.transactionRef ?? null,
      },
    });
    return row;
  }

  private move(
    complaint: ComplaintRow,
    action: ComplaintAction,
    from: ComplaintStatus = complaint.status as ComplaintStatus
  ): ComplaintStatus {
    const next = nextStatus(from, action);
    if (!next) {
      throw new AppError('COMPLAINT_TRANSITION_INVALID', {
        messageParams: { reason: `${action}_not_allowed_when_${from}` },
        details: { reason: `${action}_not_allowed_when_${from}`, status: from },
      });
    }
    return next;
  }

  private async lockOrFail(tx: Transaction, ref: string): Promise<ComplaintRow> {
    const complaint = await this.repository.lockByRef(tx, ref);
    if (!complaint) throw new AppError('NOT_FOUND');
    return complaint;
  }

  /** Locks a complaint a merchant may see, or answers "not found". */
  private async lockVisible(
    tx: Transaction,
    ref: string,
    scope: MerchantScope | undefined
  ): Promise<ComplaintRow> {
    const complaint = await this.lockOrFail(tx, ref);
    if (scope && (complaint.merchantId !== scope.merchantId || complaint.source === 'customer')) {
      throw new AppError('NOT_FOUND');
    }
    return complaint;
  }

  private async require(ref: string): Promise<ComplaintWithRefs> {
    const found = await this.repository.findByRef(ref);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }
}

function contactContext(complaintId: string): string {
  return `complaints.customer_contact:${complaintId}`;
}
