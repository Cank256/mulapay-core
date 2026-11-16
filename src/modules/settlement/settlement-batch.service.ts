/**
 * The settlement batch approval workflow (spec 6.9, 11):
 *
 *   draft --submit--> pending_approval --approve--> approved --release--> releasing --> paid
 *   draft | pending_approval | approved --cancel--> cancelled
 *
 * Submitting records who prepared the batch and which destination it will pay (by
 * fingerprint); approving needs a different person (maker-checker, also enforced by a
 * database CHECK) and fails if the destination changed since; cancelling gives back the
 * reserve the batch had claimed. Every step is one transaction with its history row and
 * audit row. **Nothing here posts to the ledger**: a batch that is draft, pending or
 * approved has moved no money (spec 6.9).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import {
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../common/pagination/cursor';
import { settlementTransitionsTotal } from '../../common/telemetry/metrics';
import { CLOCK } from '../../common/tokens';
import { MerchantEventsService } from '../events/merchant-events.service';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { assertMakerChecker, assertTransition, type BatchStatus } from './domain/batch-state';
import {
  SettlementBatchesRepository,
  type BatchRow,
  type ItemRow,
} from './settlement-batches.repository';
import { SettlementDestinationsService } from './settlement-destinations.service';
import { toSettlementView } from './settlement.views';

@Injectable()
export class SettlementBatchService {
  constructor(
    private readonly batches: SettlementBatchesRepository,
    private readonly destinations: SettlementDestinationsService,
    private readonly merchants: MerchantsRepository,
    private readonly events: MerchantEventsService,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** draft -> pending_approval. Needs an active destination that can be paid through the gateway. */
  async submit(ref: string, actorId: string): Promise<BatchRow> {
    return this.unitOfWork.run(async (tx) => {
      const batch = await this.lock(tx, ref);
      assertTransition(batch.status as BatchStatus, 'pending_approval');
      const destination = await this.destinations.findActive(tx, batch.merchantId, batch.currency);
      if (!destination) throw new AppError('SETTLEMENT_DESTINATION_MISSING');
      const provider = this.destinations.assertUsable(destination, batch.currency);
      const now = this.clock.now();
      const updated = await this.batches.update(tx, batch.id, {
        status: 'pending_approval',
        destinationId: destination.id,
        destinationFingerprint: destination.fingerprint,
        provider,
        submittedBy: actorId,
        submittedAt: now,
      });
      await this.record(tx, batch, updated, `user:${actorId}`, null);
      const merchant = await this.merchants.findById(batch.merchantId, tx);
      await this.events.emit(tx, {
        merchantId: batch.merchantId,
        environment: 'live',
        type: 'settlement.created',
        resourceType: 'settlement',
        resourceId: updated.ref,
        object: { ...toSettlementView(updated), merchant: merchant?.ref ?? null },
      });
      return updated;
    });
  }

  /** pending_approval -> approved, by someone other than the submitter. */
  async approve(ref: string, approverId: string): Promise<BatchRow> {
    return this.unitOfWork.run(async (tx) => {
      const batch = await this.lock(tx, ref);
      assertTransition(batch.status as BatchStatus, 'approved');
      assertMakerChecker(batch.submittedBy, approverId);
      const destination = batch.destinationId
        ? await this.destinations.findById(tx, batch.destinationId)
        : undefined;
      const active = await this.destinations.findActive(tx, batch.merchantId, batch.currency);
      if (
        !destination ||
        !active ||
        active.id !== destination.id ||
        active.fingerprint !== batch.destinationFingerprint
      ) {
        throw new AppError('SETTLEMENT_DESTINATION_CHANGED');
      }
      const updated = await this.batches.update(tx, batch.id, {
        status: 'approved',
        approvedBy: approverId,
        approvedAt: this.clock.now(),
      });
      await this.record(tx, batch, updated, `user:${approverId}`, null);
      return updated;
    });
  }

  /** Any state before releasing -> cancelled. The reserve it claimed becomes claimable again. */
  async cancel(ref: string, actorId: string, reason: string): Promise<BatchRow> {
    return this.unitOfWork.run(async (tx) => {
      const batch = await this.lock(tx, ref);
      assertTransition(batch.status as BatchStatus, 'cancelled');
      const updated = await this.batches.update(tx, batch.id, {
        status: 'cancelled',
        cancelledBy: `user:${actorId}`,
        cancelReason: reason.slice(0, 500),
      });
      await this.batches.unclaimReserve(tx, batch.id);
      await this.record(tx, batch, updated, `user:${actorId}`, reason.slice(0, 500));
      return updated;
    });
  }

  async get(ref: string): Promise<BatchRow> {
    const batch = await this.batches.findByRef(ref);
    if (!batch) throw new AppError('NOT_FOUND');
    return batch;
  }

  /** A merchant's own settlement. A batch of another merchant is the same 404 as a missing one. */
  async getForMerchant(merchantId: string, ref: string): Promise<BatchRow> {
    const batch = await this.batches.findByRef(ref);
    if (!batch || batch.merchantId !== merchantId || batch.status === 'draft') {
      throw new AppError('NOT_FOUND');
    }
    return batch;
  }

  async list(query: {
    merchantId?: string;
    cycleId?: string;
    status?: string;
    hideDrafts?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<BatchRow>> {
    const fingerprint = filterFingerprint({ ...query, limit: undefined, cursor: undefined });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.batches.list({
      merchantId: query.merchantId,
      cycleId: query.cycleId,
      status: query.status,
      excludeStatuses: query.hideDrafts ? ['draft'] : undefined,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  async items(
    batch: BatchRow,
    query: { limit: number; cursor?: string }
  ): Promise<{ items: ItemRow[]; nextCursor: string | null }> {
    const fingerprint = filterFingerprint({ batch: batch.ref });
    const decoded = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const [kind, id] = decoded ? decoded.id.split('|') : [];
    const rows = await this.batches.itemsOf(
      batch.id,
      decoded && kind && id ? { kind, occurredAt: decoded.createdAt, id } : undefined,
      query.limit
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(
              { createdAt: last.occurredAt ?? new Date(0), id: `${last.kind}|${last.id}` },
              fingerprint
            )
          : null,
    };
  }

  private async lock(tx: Transaction, ref: string): Promise<BatchRow> {
    const batch = await this.batches.lockByRef(tx, ref);
    if (!batch) throw new AppError('NOT_FOUND');
    return batch;
  }

  private async record(
    tx: Transaction,
    before: BatchRow,
    after: BatchRow,
    actor: string,
    note: string | null
  ): Promise<void> {
    const now = this.clock.now();
    await this.batches.addEvent(tx, {
      id: uuidv7(now),
      batchId: after.id,
      fromStatus: before.status,
      toStatus: after.status,
      kind: 'transition',
      actor,
      note,
      createdAt: now,
    });
    await this.audit.record(tx, {
      action: `settlement.batch.${after.status}`,
      resourceType: 'settlement_batch',
      resourceId: after.ref,
      merchantId: after.merchantId,
      before: { status: before.status },
      after: { status: after.status, netMinor: after.netMinor, note },
    });
    settlementTransitionsTotal.inc({ to: after.status });
  }
}
