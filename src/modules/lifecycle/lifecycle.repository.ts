/**
 * SQL for partition maintenance and retention. The DDL itself lives in the Phase 9 migration
 * (`core.ensure_partitions`, `core.drop_partition`, ...) because it needs identifiers; this
 * repository only calls those functions and runs the two batched clean-ups.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';

/** `created`, `exists`, `blocked_default_has_rows`, or `failed: <sqlstate>`. */
export type PartitionOutcome = string;

export interface EnsuredPartition {
  readonly parent: string;
  readonly partitionName: string;
  readonly monthStart: string;
  readonly outcome: PartitionOutcome;
}

export interface PartitionStatus {
  readonly parent: string;
  readonly partitions: number;
  readonly monthsAhead: number;
  readonly defaultHasRows: boolean;
}

export interface DuePartition {
  readonly parent: string;
  readonly partitionName: string;
  readonly upperBound: Date;
  readonly approxRows: number;
  readonly blockedReason: string | null;
}

@Injectable()
export class LifecycleRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Creates missing partitions (`core.ensure_partitions`). Idempotent. */
  async ensurePartitions(now: Date, monthsAhead: number): Promise<EnsuredPartition[]> {
    const result = await this.db.execute<Record<string, string>>(
      sql`select parent, partition_name, month_start::text as month_start, outcome
            from core.ensure_partitions(${now}::timestamptz, ${monthsAhead}::integer)`
    );
    return result.rows.map((r) => ({
      parent: r.parent ?? '',
      partitionName: r.partition_name ?? '',
      monthStart: r.month_start ?? '',
      outcome: r.outcome ?? '',
    }));
  }

  async partitionStatus(now: Date): Promise<PartitionStatus[]> {
    const result = await this.db.execute<Record<string, unknown>>(
      sql`select parent, partitions, months_ahead, default_has_rows
            from core.partition_status(${now}::timestamptz)`
    );
    return result.rows.map((r) => ({
      parent: String(r.parent),
      partitions: Number(r.partitions),
      monthsAhead: Number(r.months_ahead),
      defaultHasRows: r.default_has_rows === true,
    }));
  }

  async partitionsDue(now: Date): Promise<DuePartition[]> {
    const result = await this.db.execute<Record<string, unknown>>(
      sql`select parent, partition_name, upper_bound, approx_rows, blocked_reason
            from core.partitions_due_for_retention(${now}::timestamptz)`
    );
    return result.rows.map((r) => ({
      parent: String(r.parent),
      partitionName: String(r.partition_name),
      upperBound: new Date(String(r.upper_bound)),
      approxRows: Number(r.approx_rows),
      blockedReason: typeof r.blocked_reason === 'string' ? r.blocked_reason : null,
    }));
  }

  /** Drops one expired partition through `core.drop_partition`, which re-validates it. */
  async dropPartition(
    executor: Executor,
    parent: string,
    partition: string,
    now: Date
  ): Promise<void> {
    await executor.execute(
      sql`select core.drop_partition(${parent}::text, ${partition}::text, ${now}::timestamptz)`
    );
  }

  /**
   * Deletes up to `limit` idempotency rows that expired before `cutoff`. Rows another session
   * holds are skipped (`skip locked`), so a purge never waits behind a live request.
   */
  async purgeIdempotencyKeys(cutoff: Date, limit: number): Promise<number> {
    const result = await this.db.execute(sql`
      with doomed as (
        select id from core.idempotency_keys
         where expires_at < ${cutoff}
         order by expires_at
         limit ${limit}
           for update skip locked)
      delete from core.idempotency_keys k using doomed where k.id = doomed.id`);
    return result.rowCount ?? 0;
  }

  /**
   * Deletes up to `limit` outbox rows published before `cutoff`. Unpublished rows are never
   * touched. `idBound` is `uuidTimeBound(cutoff)`: outbox ids are time-ordered, so it turns the
   * scan into a primary key range (see retention-policy.ts).
   */
  async purgePublishedOutbox(cutoff: Date, idBound: string, limit: number): Promise<number> {
    const result = await this.db.execute(sql`
      with doomed as (
        select id from core.outbox
         where id < ${idBound}::uuid
           and published_at is not null
           and published_at < ${cutoff}
         order by id
         limit ${limit}
           for update skip locked)
      delete from core.outbox o using doomed where o.id = doomed.id`);
    return result.rowCount ?? 0;
  }
}
