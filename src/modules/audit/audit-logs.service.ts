/**
 * Admin audit log reads and chain verification (spec 6.14, 7.3 `/audit-logs`).
 *
 * Lists default to the last 90 days and accept at most a 366-day window, so every query
 * prunes partitions (spec 9.2 rule 6). Verification walks the whole chain from the
 * genesis hash in batches and reports the first break; it finally checks that the chain
 * head row agrees with the last row, which catches deletion of the newest rows.
 */
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { GENESIS_HASH, verifyBatch, type ChainBreak } from '../../common/audit/audit-chain';
import type { Clock } from '../../common/clock/clock';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, encodeCursor, filterFingerprint } from '../../common/pagination/cursor';
import { CLOCK } from '../../common/tokens';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { AuditLogsRepository } from './audit-logs.repository';

const DAY_MS = 86_400_000;
export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 366;
const VERIFY_BATCH = 1000;

export const auditLogSchema = z.object({
  seq: z.number().int(),
  actorType: z.enum(['user', 'api_key', 'system', 'job']),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  merchantId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changedFields: z.array(z.string()),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  traceId: z.string().nullable(),
  surface: z.string().nullable(),
  outcome: z.enum(['success', 'denied', 'error']),
  prevHash: z.string(),
  hash: z.string(),
  createdAt: z.iso.datetime(),
});
export type AuditLogView = z.infer<typeof auditLogSchema>;

export const chainVerificationSchema = z.object({
  valid: z.boolean(),
  checked: z.number().int(),
  lastSeq: z.number().int(),
  firstBreak: z
    .object({
      seq: z.number().int(),
      reason: z.enum(['sequence_gap', 'prev_hash_mismatch', 'hash_mismatch', 'head_mismatch']),
    })
    .nullable(),
});
export type ChainVerification = z.infer<typeof chainVerificationSchema>;

export interface AuditListQuery {
  readonly from?: Date;
  readonly to?: Date;
  readonly merchant?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome?: 'success' | 'denied' | 'error';
  readonly limit: number;
  readonly cursor?: string;
}

type Row = Awaited<ReturnType<AuditLogsRepository['list']>>[number];

function toView({ log, merchantRef }: Row): AuditLogView {
  return {
    seq: log.seq,
    actorType: log.actorType as AuditLogView['actorType'],
    actorId: log.actorId,
    actorLabel: log.actorLabel,
    merchantId: merchantRef,
    action: log.action,
    resourceType: log.resourceType,
    resourceId: log.resourceId,
    before: log.before,
    after: log.after,
    changedFields: log.changedFields,
    ip: log.ip,
    userAgent: log.userAgent,
    requestId: log.requestId,
    traceId: log.traceId,
    surface: log.surface,
    outcome: log.outcome as AuditLogView['outcome'],
    prevHash: log.prevHash,
    hash: log.hash,
    createdAt: log.createdAt.toISOString(),
  };
}

@Injectable()
export class AuditLogsService {
  constructor(
    private readonly logs: AuditLogsRepository,
    private readonly merchants: MerchantsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async list(query: AuditListQuery): Promise<{ items: AuditLogView[]; nextCursor: string | null }> {
    const to = query.to ?? this.clock.now();
    const from = query.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
    if (from.getTime() > to.getTime() || to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      throw new AppError('VALIDATION_FAILED', {
        details: {
          fields: [
            {
              path: 'from',
              code: 'invalid_range',
              message: `window must be 0 to ${MAX_WINDOW_DAYS} days`,
            },
          ],
        },
      });
    }
    let merchantId: string | undefined;
    if (query.merchant) {
      const merchant = await this.merchants.findByRef(query.merchant);
      if (!merchant) return { items: [], nextCursor: null };
      merchantId = merchant.id;
    }
    const fingerprint = filterFingerprint({
      from: from.toISOString(),
      to: to.toISOString(),
      merchant: query.merchant,
      action: query.action,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      outcome: query.outcome,
    });
    const cursorKey = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const after = cursorKey
      ? { createdAt: cursorKey.createdAt, seq: Number(cursorKey.id) }
      : undefined;
    if (after && !Number.isSafeInteger(after.seq)) throw new AppError('INVALID_CURSOR');
    const rows = await this.logs.list({
      ...query,
      from,
      to,
      merchantId,
      after,
      limit: query.limit,
    });
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeCursor({ createdAt: last.log.createdAt, id: String(last.log.seq) }, fingerprint)
        : null;
    return { items: items.map(toView), nextCursor };
  }

  async get(seq: number): Promise<AuditLogView> {
    const row = await this.logs.findBySeq(seq);
    if (!row) throw new AppError('NOT_FOUND');
    return toView(row);
  }

  /**
   * Verifies the chain up to a snapshot of the head taken first. A row and its head update
   * commit together, so every row up to the snapshot is visible; rows appended while the
   * walk runs are outside the snapshot and are checked by the next run.
   */
  async verify(): Promise<ChainVerification> {
    const head = await this.logs.head();
    const target = { lastSeq: head?.lastSeq ?? 0, lastHash: head?.lastHash ?? GENESIS_HASH };
    let cursor = { lastSeq: 0, lastHash: GENESIS_HASH };
    let checked = 0;
    let firstBreak: ChainBreak | null = null;
    while (cursor.lastSeq < target.lastSeq) {
      const rows = await this.logs.batch(cursor.lastSeq, target.lastSeq, VERIFY_BATCH);
      if (rows.length === 0) break;
      const result = verifyBatch(cursor, rows);
      if (!result.ok) {
        firstBreak = result.break;
        break;
      }
      checked += rows.length;
      cursor = result.cursor;
    }
    // Missing newest rows, or a head that does not match the last row, is a break.
    if (!firstBreak && (cursor.lastSeq !== target.lastSeq || cursor.lastHash !== target.lastHash)) {
      firstBreak = { seq: target.lastSeq, reason: 'head_mismatch' };
    }
    return { valid: firstBreak === null, checked, lastSeq: cursor.lastSeq, firstBreak };
  }
}
