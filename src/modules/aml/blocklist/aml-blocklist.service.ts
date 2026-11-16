/**
 * The blocklist (spec 6.13, 5.2 `aml_blocklist`): phone numbers, emails, accounts, card BINs,
 * devices and names that may not transact.
 *
 * Invariants upheld:
 *  - Only a keyed hash of each value is stored (`PiiHasher`), plus its last four characters
 *    so staff can recognise an entry. The list cannot be read back as a list of numbers.
 *  - PostgreSQL holds the list; Redis holds a mirror the pre-transaction check reads
 *    (`aml:bl:{type}`, field = hash, value = expiry in ms or 0). Redis is rebuilt from the
 *    database, never the other way, and a lookup that cannot reach Redis fails closed.
 *  - A change is committed first, then mirrored. If the mirror write fails the call fails
 *    (503) so the caller retries; the retry finds the entry and mirrors it again, and the
 *    periodic rebuild repairs anything missed.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import { PiiHasher } from '../../../common/crypto/pii-hasher';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { publicId, uuidv7 } from '../../../common/ids/ids';
import { toLoggableError } from '../../../common/logging/redaction';
import {
  decodeCursor,
  filterFingerprint,
  toPage,
  type Page,
} from '../../../common/pagination/cursor';
import { REDIS } from '../../../common/redis/redis.module';
import { CLOCK, ROOT_LOGGER } from '../../../common/tokens';
import { normalizeMsisdn } from '../../payments/domain/payment-input';
import { AmlBlocklistRepository, type BlocklistRow } from './aml-blocklist.repository';

export const BLOCKLIST_TYPES = ['msisdn', 'email', 'account', 'bin', 'device', 'name'] as const;
export type BlocklistType = (typeof BLOCKLIST_TYPES)[number];

const READY_KEY = 'aml:bl:ready';
const mirrorKey = (type: string) => `aml:bl:${type}`;

export interface BlocklistCandidate {
  readonly type: BlocklistType;
  readonly value: string;
}

/** The form a value is compared in: msisdns in E.164, text trimmed and lower-cased. */
export function normalizeBlocklistValue(type: BlocklistType, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (type === 'msisdn') return normalizeMsisdn(trimmed);
  return trimmed.toLowerCase().replace(/\s+/g, ' ');
}

export interface AddBlocklistInput {
  readonly type: BlocklistType;
  readonly value: string;
  readonly reason: string;
  readonly expiresAt?: Date;
}

@Injectable()
export class AmlBlocklistService {
  constructor(
    private readonly entries: AmlBlocklistRepository,
    private readonly hasher: PiiHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  private digest(type: BlocklistType, normalized: string): string {
    return this.hasher.digest(`blocklist:${type}`, normalized);
  }

  /** Adds an entry; adding the same active value again returns the existing entry. */
  async add(input: AddBlocklistInput, actorUserId: string): Promise<BlocklistRow> {
    const normalized = normalizeBlocklistValue(input.type, input.value);
    if (!normalized) {
      throw new AppError('VALIDATION_FAILED', {
        details: { fields: [{ path: 'value', message: 'is not valid for this type' }] },
      });
    }
    const now = this.clock.now();
    if (input.expiresAt && input.expiresAt <= now) {
      throw new AppError('VALIDATION_FAILED', {
        details: { fields: [{ path: 'expiresAt', message: 'must be in the future' }] },
      });
    }
    const hmac = this.digest(input.type, normalized);
    const row = await this.unitOfWork.run(async (tx) => {
      const inserted = await this.entries.insert(tx, {
        id: uuidv7(now),
        ref: publicId('blocklistEntry', now),
        entryType: input.type,
        valueHmac: hmac,
        valueHint: normalized.slice(-4),
        reason: input.reason,
        addedBy: actorUserId,
        expiresAt: input.expiresAt ?? null,
      });
      if (!inserted) return this.entries.findActive(input.type, hmac, tx);
      await this.audit.record(tx, {
        action: 'aml.blocklist.added',
        resourceType: 'aml_blocklist',
        resourceId: inserted.ref,
        after: {
          type: inserted.entryType,
          hint: inserted.valueHint,
          reason: inserted.reason,
          expiresAt: inserted.expiresAt?.toISOString() ?? null,
        },
      });
      return inserted;
    });
    if (!row) throw new Error('blocklist entry vanished after insert');
    await this.mirror(row);
    return row;
  }

  async remove(ref: string, actorUserId: string): Promise<BlocklistRow> {
    const row = await this.unitOfWork.run(async (tx) => {
      const current = await this.entries.lockByRef(tx, ref);
      if (!current) throw new AppError('NOT_FOUND');
      if (current.removedAt) return current;
      const removed = await this.entries.markRemoved(tx, current.id, actorUserId, this.clock.now());
      await this.audit.record(tx, {
        action: 'aml.blocklist.removed',
        resourceType: 'aml_blocklist',
        resourceId: removed.ref,
        before: { type: removed.entryType, hint: removed.valueHint },
        after: { removed: true },
      });
      return removed;
    });
    await this.unmirror(row);
    return row;
  }

  async list(query: {
    entryType?: string;
    includeRemoved?: boolean;
    limit: number;
    cursor?: string;
  }): Promise<Page<BlocklistRow>> {
    const fingerprint = filterFingerprint({
      type: query.entryType,
      removed: query.includeRemoved ?? false,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.entries.list({
      entryType: query.entryType,
      includeRemoved: query.includeRemoved ?? false,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  /**
   * True when any candidate is on the list. One Redis round trip for any number of
   * candidates (spec 6.13: under 20 ms). Throws, and so declines the transaction, when Redis
   * cannot answer.
   */
  async isBlocked(candidates: readonly BlocklistCandidate[]): Promise<boolean> {
    const prepared = candidates.flatMap((c) => {
      const normalized = normalizeBlocklistValue(c.type, c.value);
      return normalized ? [{ type: c.type, digest: this.digest(c.type, normalized) }] : [];
    });
    if (prepared.length === 0) return false;
    let answers = await this.lookup(prepared);
    if (answers === null) {
      await this.rebuild();
      answers = await this.lookup(prepared);
      if (answers === null) throw new Error('blocklist mirror is not ready after a rebuild');
    }
    const now = this.clock.now().getTime();
    return answers.some((expiry) => expiry !== null && (expiry === 0 || expiry > now));
  }

  /** Reloads the Redis mirror from the database. Safe to run at any time and in parallel. */
  async rebuild(): Promise<number> {
    const rows = await this.entries.listActive();
    const byType = new Map<string, Record<string, string>>();
    for (const type of BLOCKLIST_TYPES) byType.set(type, {});
    for (const row of rows) {
      const fields = byType.get(row.entryType);
      if (fields) fields[row.valueHmac] = String(row.expiresAt?.getTime() ?? 0);
    }
    const stamp = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const pipeline = this.redis.pipeline();
    for (const [type, fields] of byType) {
      const temp = `${mirrorKey(type)}:${stamp}`;
      if (Object.keys(fields).length > 0) {
        pipeline.hset(temp, fields);
        pipeline.rename(temp, mirrorKey(type));
      } else {
        pipeline.del(mirrorKey(type));
      }
    }
    pipeline.set(READY_KEY, '1');
    const results = await pipeline.exec();
    for (const [error] of results ?? []) if (error) throw error;
    return rows.length;
  }

  private async lookup(
    prepared: readonly { type: BlocklistType; digest: string }[]
  ): Promise<Array<number | null> | null> {
    const pipeline = this.redis.pipeline();
    pipeline.exists(READY_KEY);
    for (const p of prepared) pipeline.hget(mirrorKey(p.type), p.digest);
    const results = await pipeline.exec();
    if (!results) throw new Error('redis pipeline returned nothing');
    for (const [error] of results) if (error) throw error;
    if (results[0]?.[1] !== 1) return null;
    return results.slice(1).map(([, value]) => (typeof value === 'string' ? Number(value) : null));
  }

  private async mirror(row: BlocklistRow): Promise<void> {
    try {
      await this.redis.hset(
        mirrorKey(row.entryType),
        row.valueHmac,
        String(row.expiresAt?.getTime() ?? 0)
      );
    } catch (error) {
      this.logger.error(
        { err: toLoggableError(error), entry: row.ref },
        'blocklist entry committed but not mirrored to redis'
      );
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
    }
  }

  private async unmirror(row: BlocklistRow): Promise<void> {
    try {
      await this.redis.hdel(mirrorKey(row.entryType), row.valueHmac);
    } catch (error) {
      this.logger.error(
        { err: toLoggableError(error), entry: row.ref },
        'blocklist entry removed but still mirrored in redis'
      );
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
    }
  }
}
