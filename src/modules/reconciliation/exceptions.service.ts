/**
 * The exception queue (spec 6.8): assignment, investigation notes, status and resolution.
 *
 * Resolutions and what they may do:
 *
 *   matched_manually          a person checked and the records agree. No money moves; the
 *                             note says what was checked. Resolves at once.
 *   corrected_with_reversal   a posted entry was wrong and is reversed through
 *                             `ReversalService` (a new entry with every direction flipped).
 *   written_off               a loss is accepted: debit `5100:loss_writeoff`, credit the
 *                             platform asset account that holds the unexplained amount.
 *
 * The last two move money, so they need a second person (spec 6.6, 11): the resolution is
 * recorded as a request, a different staff member approves or rejects it, and the entry is
 * posted in the same transaction as the approval. A rejected request leaves the exception
 * `investigating`. Every step writes an audit row and a queue note in its own transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Executor, Transaction } from '../../common/db/database.types';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { CLOCK } from '../../common/tokens';
import { ledgerIdempotencyKey } from '../ledger/domain/posting';
import { PostingService } from '../ledger/posting.service';
import { ReversalService } from '../ledger/reversal.service';
import { isOpenStatus } from './domain/exception-kinds';
import { ReconciliationQueriesRepository } from './reconciliation-queries.repository';
import { isWriteOffSource, LOSS_WRITEOFF_ACCOUNT } from './domain/resolution';
import {
  ReconciliationExceptionsRepository,
  type ExceptionRow,
  type NoteRow,
  type ResolutionRequestRow,
} from './reconciliation-exceptions.repository';

export type ResolveInput =
  | { readonly resolution: 'matched_manually'; readonly note: string }
  | {
      readonly resolution: 'corrected_with_reversal';
      readonly note: string;
      readonly entryRef: string;
    }
  | {
      readonly resolution: 'written_off';
      readonly note: string;
      readonly accountCode: string;
      /** Minor units, a digit string. */
      readonly amountMinor: string;
    };

export interface ResolveResult {
  readonly exception: ExceptionRow;
  /** Set when the resolution waits for a second person. */
  readonly request: ResolutionRequestRow | null;
}

export interface ExceptionDetail {
  readonly exception: ExceptionRow;
  readonly notes: NoteRow[];
  readonly requests: ResolutionRequestRow[];
}

function state(reason: string): AppError {
  return new AppError('RECONCILIATION_EXCEPTION_STATE', {
    messageParams: { reason },
    details: { reason },
  });
}

function badResolution(reason: string): AppError {
  return new AppError('RECONCILIATION_RESOLUTION_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

@Injectable()
export class ReconciliationExceptionsService {
  constructor(
    private readonly exceptions: ReconciliationExceptionsRepository,
    private readonly queries: ReconciliationQueriesRepository,
    private readonly posting: PostingService,
    private readonly reversal: ReversalService,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async list(query: {
    status?: string;
    openOnly?: boolean;
    kind?: string;
    severity?: string;
    assignedTo?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<ExceptionRow>> {
    const fingerprint = filterFingerprint({ ...query, limit: undefined, cursor: undefined });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.exceptions.list({ ...query, after });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  async get(ref: string): Promise<ExceptionDetail> {
    const exception = await this.exceptions.findByRef(ref);
    if (!exception) throw new AppError('NOT_FOUND');
    const [notes, requests] = await Promise.all([
      this.exceptions.listNotes(exception.id),
      this.exceptions.requestsForException(exception.id),
    ]);
    return { exception, notes, requests };
  }

  /** The public refs of the staff the given exceptions are assigned to. */
  assigneeRefs(rows: readonly ExceptionRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => (r.assignedTo ? [r.assignedTo] : [])))];
    return this.queries.userRefs(ids);
  }

  /**
   * The internal id of an active staff user who may work the queue (`reconciliation:read` or
   * `reconciliation:work`), or a not-found error.
   */
  async staffId(userRef: string): Promise<string> {
    const id = await this.queries.exceptionAssigneeIdByRef(userRef);
    if (!id) throw new AppError('NOT_FOUND');
    return id;
  }

  /** Gives the exception an owner and moves it to `investigating`. */
  async assign(ref: string, assigneeId: string, actorId: string): Promise<ExceptionRow> {
    return this.unitOfWork.run(async (tx) => {
      const exception = await this.lockOpen(tx, ref);
      const updated = await this.exceptions.update(tx, exception.id, {
        status: 'investigating',
        assignedTo: assigneeId,
        assignedAt: this.clock.now(),
      });
      await this.note(tx, exception.id, 'assignment', actorId, `Assigned to ${assigneeId}`);
      await this.audit.record(tx, {
        action: 'reconciliation.exception.assigned',
        resourceType: 'reconciliation_exception',
        resourceId: ref,
        before: { status: exception.status, assignedTo: exception.assignedTo },
        after: { status: updated.status, assignedTo: updated.assignedTo },
      });
      return updated;
    });
  }

  async addNote(ref: string, body: string, authorId: string): Promise<NoteRow> {
    return this.unitOfWork.run(async (tx) => {
      const exception = await this.exceptions.lockByRef(tx, ref);
      if (!exception) throw new AppError('NOT_FOUND');
      const note = await this.note(tx, exception.id, 'note', authorId, body);
      await this.audit.record(tx, {
        action: 'reconciliation.exception.noted',
        resourceType: 'reconciliation_exception',
        resourceId: ref,
        after: { note: note.id },
      });
      return note;
    });
  }

  /** Starts or completes a resolution (see the file comment for what each does). */
  async resolve(ref: string, input: ResolveInput, actorId: string): Promise<ResolveResult> {
    const note = input.note.trim();
    if (note.length < 3 || note.length > 1000) throw badResolution('note');
    return this.unitOfWork.run(async (tx) => {
      const exception = await this.lockOpen(tx, ref);
      const now = this.clock.now();
      const waiting = await this.exceptions.requestsForException(exception.id, tx);
      if (waiting.some((r) => r.status === 'pending')) {
        throw state('a_resolution_is_already_waiting_for_approval');
      }

      if (input.resolution === 'matched_manually') {
        const updated = await this.exceptions.update(tx, exception.id, {
          status: 'resolved',
          resolution: 'matched_manually',
          resolutionNote: note,
          resolvedBy: actorId,
          resolvedAt: now,
        });
        await this.note(tx, exception.id, 'resolution', actorId, `Matched manually: ${note}`);
        await this.audit.record(tx, {
          action: 'reconciliation.exception.resolved',
          resourceType: 'reconciliation_exception',
          resourceId: ref,
          before: { status: exception.status },
          after: { status: updated.status, resolution: 'matched_manually' },
        });
        return { exception: updated, request: null };
      }

      const request = await this.createRequest(tx, exception, input, note, actorId, now);
      const held =
        exception.status === 'open'
          ? await this.exceptions.update(tx, exception.id, { status: 'investigating' })
          : exception;
      await this.note(
        tx,
        exception.id,
        'resolution',
        actorId,
        `Requested ${input.resolution} (${request.ref}), waiting for approval: ${note}`
      );
      await this.audit.record(tx, {
        action: 'reconciliation.resolution.requested',
        resourceType: 'reconciliation_exception',
        resourceId: ref,
        after: { request: request.ref, kind: request.kind, amountMinor: request.amountMinor },
      });
      return { exception: held, request };
    });
  }

  /**
   * Approves or rejects a resolution request. The decider is never the requester. An
   * approval posts the reversal or write-off entry in this same transaction, so either
   * the exception is resolved and the entry exists, or neither.
   */
  async decide(
    requestRef: string,
    decision: 'approve' | 'reject',
    note: string | null,
    approverId: string
  ): Promise<ResolveResult> {
    return this.unitOfWork.run(async (tx) => {
      const request = await this.exceptions.lockRequestByRef(tx, requestRef);
      if (!request) throw new AppError('NOT_FOUND');
      if (request.status !== 'pending') throw state('request_already_decided');
      if (request.requestedBy === approverId) {
        throw new AppError('RECONCILIATION_APPROVER_IS_REQUESTER');
      }
      const exception = await this.exceptions.lockByRef(
        tx,
        await this.refOf(tx, request.exceptionId)
      );
      if (!exception || !isOpenStatus(exception.status)) throw state('exception_not_open');
      const now = this.clock.now();

      if (decision === 'reject') {
        const rejected = await this.exceptions.decideRequest(tx, request.id, {
          status: 'rejected',
          decidedBy: approverId,
          decidedAt: now,
          decisionNote: note,
          entryRef: null,
        });
        await this.note(
          tx,
          exception.id,
          'approval',
          approverId,
          `Rejected ${request.ref}: ${note ?? 'no reason given'}`
        );
        await this.audit.record(tx, {
          action: 'reconciliation.resolution.rejected',
          resourceType: 'reconciliation_exception',
          resourceId: exception.ref,
          after: { request: request.ref, kind: request.kind },
        });
        return { exception, request: rejected };
      }

      const entryRef = await this.postResolution(tx, request, exception, approverId);
      const approved = await this.exceptions.decideRequest(tx, request.id, {
        status: 'approved',
        decidedBy: approverId,
        decidedAt: now,
        decisionNote: note,
        entryRef,
      });
      const written = request.kind === 'written_off';
      const updated = await this.exceptions.update(tx, exception.id, {
        status: written ? 'written_off' : 'resolved',
        resolution: request.kind,
        resolutionNote: request.reason,
        resolvedBy: approverId,
        resolvedAt: now,
        resolutionEntryRef: entryRef,
      });
      await this.note(
        tx,
        exception.id,
        'approval',
        approverId,
        `Approved ${request.ref}; ledger entry ${entryRef}`
      );
      await this.audit.record(tx, {
        action: written
          ? 'reconciliation.exception.written_off'
          : 'reconciliation.exception.reversed',
        resourceType: 'reconciliation_exception',
        resourceId: exception.ref,
        before: { status: exception.status },
        after: { status: updated.status, request: request.ref, entry: entryRef },
      });
      return { exception: updated, request: approved };
    });
  }

  listPendingRequests(limit = 100) {
    return this.exceptions.listPendingRequests(limit);
  }

  private async createRequest(
    tx: Transaction,
    exception: ExceptionRow,
    input: Exclude<ResolveInput, { resolution: 'matched_manually' }>,
    note: string,
    actorId: string,
    now: Date
  ): Promise<ResolutionRequestRow> {
    if (exception.environment !== 'live') throw badResolution('environment');
    let payload: Record<string, string>;
    let currency: string | null = null;
    let amountMinor: bigint | null = null;

    if (input.resolution === 'corrected_with_reversal') {
      const entry = await this.queries.entryReversalState(input.entryRef, tx);
      if (!entry) throw badResolution('entry_not_found');
      if (entry.environment !== 'live') throw badResolution('environment');
      if (entry.isReversal) throw badResolution('entry_is_a_reversal');
      payload = { entryRef: input.entryRef };
    } else {
      if (!isWriteOffSource(input.accountCode)) throw badResolution('account');
      if (!/^[1-9][0-9]{0,17}$/.test(input.amountMinor)) throw badResolution('amount');
      amountMinor = BigInt(input.amountMinor);
      currency = exception.currency;
      if (!currency || !isSupportedCurrency(currency)) throw badResolution('currency');
      if (exception.amountMinor === null || amountMinor > exception.amountMinor) {
        // A write-off never exceeds the discrepancy it clears.
        throw badResolution('amount_exceeds_exception');
      }
      payload = { accountCode: input.accountCode };
    }
    try {
      return await this.exceptions.insertRequest(tx, {
        id: uuidv7(now),
        ref: publicId('reconResolution', now),
        exceptionId: exception.id,
        kind: input.resolution,
        payload,
        currency,
        amountMinor,
        reason: note,
        requestedBy: actorId,
        requestedAt: now,
        createdAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error, 'reconciliation_resolution_requests_pending_key')) {
        throw state('a_resolution_is_already_waiting_for_approval');
      }
      throw error;
    }
  }

  private async postResolution(
    tx: Transaction,
    request: ResolutionRequestRow,
    exception: ExceptionRow,
    approverId: string
  ): Promise<string> {
    const actor = { type: 'user', id: approverId } as const;
    if (request.kind === 'corrected_with_reversal') {
      const { entry } = await this.reversal.reverseEntry(tx, {
        entry: { ref: request.payload.entryRef as string },
        reason: `Reconciliation ${exception.ref}: ${request.reason}`.slice(0, 500),
        createdBy: actor,
      });
      return entry.ref;
    }
    const sourceId = `writeoff:${request.ref}`;
    const amount = request.amountMinor as bigint;
    const { entry } = await this.posting.postEntry(tx, {
      idempotencyKey: ledgerIdempotencyKey('adjustment', sourceId),
      environment: 'live',
      currency: request.currency as string,
      source: 'adjustment',
      sourceId,
      kind: 'reconciliation.writeoff',
      description: `Write-off of ${exception.ref}: ${request.reason}`.slice(0, 500),
      lines: [
        { accountCode: LOSS_WRITEOFF_ACCOUNT, direction: 'debit', amountMinor: amount },
        {
          accountCode: request.payload.accountCode as string,
          direction: 'credit',
          amountMinor: amount,
        },
      ],
      createdBy: actor,
    });
    return entry.ref;
  }

  private async lockOpen(tx: Transaction, ref: string): Promise<ExceptionRow> {
    const exception = await this.exceptions.lockByRef(tx, ref);
    if (!exception) throw new AppError('NOT_FOUND');
    if (!isOpenStatus(exception.status)) throw state(`already_${exception.status}`);
    return exception;
  }

  private async refOf(tx: Executor, exceptionId: string): Promise<string> {
    const result = await this.exceptions.refById(tx, exceptionId);
    if (!result) throw new AppError('NOT_FOUND');
    return result;
  }

  private note(
    tx: Executor,
    exceptionId: string,
    kind: NoteRow['kind'],
    authorId: string,
    body: string
  ) {
    return this.exceptions.addNote(tx, {
      id: uuidv7(this.clock.now()),
      exceptionId,
      kind,
      authorId,
      body: body.slice(0, 2000),
      createdAt: this.clock.now(),
    });
  }
}
