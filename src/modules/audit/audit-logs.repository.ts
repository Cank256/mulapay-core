/**
 * Reads of `core.audit_logs`, a partitioned table (spec 5.1): list queries always carry a
 * `created_at` range so the planner prunes partitions. Chain verification reads every row
 * in `seq` order by design.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_REPLICA, DB_RW } from '../../common/db/tokens';
import { auditChainHead, auditLogs, merchants } from '../../db/schema';

export interface AuditListFilter {
  readonly from: Date;
  readonly to: Date;
  readonly merchantId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome?: 'success' | 'denied' | 'error';
  readonly after?: { createdAt: Date; seq: number };
  readonly limit: number;
}

const columns = { log: auditLogs, merchantRef: merchants.ref };

@Injectable()
export class AuditLogsRepository {
  constructor(
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(DB_REPLICA) private readonly replica: Executor
  ) {}

  list(filter: AuditListFilter) {
    const conditions: (SQL | undefined)[] = [
      gte(auditLogs.createdAt, filter.from),
      lte(auditLogs.createdAt, filter.to),
      filter.merchantId ? eq(auditLogs.merchantId, filter.merchantId) : undefined,
      filter.action ? eq(auditLogs.action, filter.action) : undefined,
      filter.resourceType ? eq(auditLogs.resourceType, filter.resourceType) : undefined,
      filter.resourceId ? eq(auditLogs.resourceId, filter.resourceId) : undefined,
      filter.outcome ? eq(auditLogs.outcome, filter.outcome) : undefined,
    ];
    if (filter.after) {
      conditions.push(
        or(
          lt(auditLogs.createdAt, filter.after.createdAt),
          and(eq(auditLogs.createdAt, filter.after.createdAt), lt(auditLogs.seq, filter.after.seq))
        )
      );
    }
    return this.replica
      .select(columns)
      .from(auditLogs)
      .leftJoin(merchants, eq(merchants.id, auditLogs.merchantId))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.seq))
      .limit(filter.limit + 1);
  }

  async findBySeq(seq: number) {
    const [row] = await this.replica
      .select(columns)
      .from(auditLogs)
      .leftJoin(merchants, eq(merchants.id, auditLogs.merchantId))
      .where(eq(auditLogs.seq, seq))
      .limit(1);
    return row;
  }

  /** Rows with afterSeq < seq <= upToSeq, ascending. Reads the primary, like the head. */
  batch(afterSeq: number, upToSeq: number, limit: number) {
    return this.db
      .select()
      .from(auditLogs)
      .where(and(gt(auditLogs.seq, afterSeq), lte(auditLogs.seq, upToSeq)))
      .orderBy(asc(auditLogs.seq))
      .limit(limit);
  }

  async head() {
    const [row] = await this.db.select().from(auditChainHead).where(eq(auditChainHead.id, 1));
    return row;
  }
}
