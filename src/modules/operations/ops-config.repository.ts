/** SQL for feature flags, provider status, routing rules, consumer cursors and maintenance mode. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RO, DB_RW } from '../../common/db/tokens';
import {
  consumerCursors,
  featureFlags,
  maintenanceState,
  providerStatus,
  routingRules,
  users,
} from '../../db/schema';

export type FlagRow = typeof featureFlags.$inferSelect;
export type ProviderRow = typeof providerStatus.$inferSelect;
export type RuleRow = typeof routingRules.$inferSelect;
export type NewRule = typeof routingRules.$inferInsert;
export type CursorRow = typeof consumerCursors.$inferSelect;
export type MaintenanceRow = typeof maintenanceState.$inferSelect;

@Injectable()
export class OpsConfigRepository {
  constructor(
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(DB_RO) private readonly ro: Executor
  ) {}

  // -- feature flags -----------------------------------------------------------------------

  listFlags(): Promise<FlagRow[]> {
    return this.db.select().from(featureFlags).orderBy(asc(featureFlags.key));
  }

  async findFlag(key: string, tx: Executor = this.db): Promise<FlagRow | undefined> {
    const [row] = await tx.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1);
    return row;
  }

  async lockFlag(tx: Executor, key: string): Promise<FlagRow | undefined> {
    const [row] = await tx
      .select()
      .from(featureFlags)
      .where(eq(featureFlags.key, key))
      .for('update');
    return row;
  }

  async insertFlag(tx: Executor, values: typeof featureFlags.$inferInsert): Promise<FlagRow> {
    const [row] = await tx.insert(featureFlags).values(values).returning();
    if (!row) throw new Error('flag insert returned no row');
    return row;
  }

  async updateFlag(
    tx: Executor,
    id: string,
    patch: Partial<
      Pick<
        typeof featureFlags.$inferInsert,
        'enabled' | 'rolloutPercent' | 'merchantAllowlist' | 'description' | 'updatedBy'
      >
    >
  ): Promise<FlagRow> {
    const [row] = await tx
      .update(featureFlags)
      .set(patch)
      .where(eq(featureFlags.id, id))
      .returning();
    if (!row) throw new Error('flag update returned no row');
    return row;
  }

  // -- providers ---------------------------------------------------------------------------

  listProviders(tx: Executor = this.db): Promise<ProviderRow[]> {
    return tx.select().from(providerStatus).orderBy(asc(providerStatus.provider));
  }

  async lockProvider(tx: Executor, provider: string): Promise<ProviderRow | undefined> {
    const [row] = await tx
      .select()
      .from(providerStatus)
      .where(eq(providerStatus.provider, provider))
      .for('update');
    return row;
  }

  async updateProvider(
    tx: Executor,
    provider: string,
    patch: Partial<Pick<ProviderRow, 'enabled' | 'health' | 'note' | 'updatedBy'>>
  ): Promise<ProviderRow> {
    const [row] = await tx
      .update(providerStatus)
      .set(patch)
      .where(eq(providerStatus.provider, provider))
      .returning();
    if (!row) throw new Error('provider update returned no row');
    return row;
  }

  // -- routing rules -----------------------------------------------------------------------

  listRules(
    filter: { currency?: string; provider?: string } = {},
    tx: Executor = this.db
  ): Promise<RuleRow[]> {
    return tx
      .select()
      .from(routingRules)
      .where(
        and(
          filter.currency ? eq(routingRules.currency, filter.currency) : undefined,
          filter.provider ? eq(routingRules.provider, filter.provider) : undefined
        )
      )
      .orderBy(asc(routingRules.currency), asc(routingRules.priority), asc(routingRules.ref));
  }

  async findRule(ref: string, tx: Executor = this.db): Promise<RuleRow | undefined> {
    const [row] = await tx.select().from(routingRules).where(eq(routingRules.ref, ref)).limit(1);
    return row;
  }

  /** Serialises rule changes of one currency so "the last enabled rule" is decided on a stable set. */
  async lockCurrencyRules(tx: Executor, currency: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`routing_rules:${currency}`}, 0))`
    );
  }

  async lockRule(tx: Executor, ref: string): Promise<RuleRow | undefined> {
    const [row] = await tx
      .select()
      .from(routingRules)
      .where(eq(routingRules.ref, ref))
      .for('update');
    return row;
  }

  async insertRule(tx: Executor, values: NewRule): Promise<RuleRow> {
    const [row] = await tx.insert(routingRules).values(values).returning();
    if (!row) throw new Error('routing rule insert returned no row');
    return row;
  }

  async updateRule(
    tx: Executor,
    id: string,
    patch: Partial<Omit<NewRule, 'id' | 'ref' | 'createdAt'>>
  ): Promise<RuleRow> {
    const [row] = await tx
      .update(routingRules)
      .set(patch)
      .where(eq(routingRules.id, id))
      .returning();
    if (!row) throw new Error('routing rule update returned no row');
    return row;
  }

  async deleteRule(tx: Executor, id: string): Promise<void> {
    await tx.delete(routingRules).where(eq(routingRules.id, id));
  }

  // -- consumer cursors --------------------------------------------------------------------

  listCursors(): Promise<CursorRow[]> {
    return this.db.select().from(consumerCursors).orderBy(asc(consumerCursors.name));
  }

  async lockCursor(tx: Executor, name: string): Promise<CursorRow | undefined> {
    const [row] = await tx
      .select()
      .from(consumerCursors)
      .where(eq(consumerCursors.name, name))
      .for('update');
    return row;
  }

  async setCursorPosition(tx: Executor, name: string, position: bigint): Promise<void> {
    await tx.update(consumerCursors).set({ position }).where(eq(consumerCursors.name, name));
  }

  /**
   * How far behind the gateway's event stream a cursor is, read through the read-only role
   * (spec D2). Null when the gateway tables are not readable, so the console says "unknown"
   * rather than "zero".
   */
  async gatewayLag(
    tenantId: string,
    position: bigint
  ): Promise<{ head: bigint; behind: bigint; oldestUnprocessedAt: Date | null } | null> {
    try {
      const result = await this.ro.execute<{
        head: string | null;
        behind: string;
        oldest: string | null;
      }>(sql`
        select (select max(id) from public.operation_events where tenant_id = ${tenantId})::text as head,
               (select count(*) from public.operation_events where tenant_id = ${tenantId} and id > ${position.toString()}::bigint)::text as behind,
               (select to_json(min(occurred_at)) #>> '{}' from public.operation_events
                 where tenant_id = ${tenantId} and id > ${position.toString()}::bigint) as oldest`);
      const r = result.rows[0];
      if (!r) return null;
      return {
        head: BigInt(r.head ?? '0'),
        behind: BigInt(r.behind),
        oldestUnprocessedAt: r.oldest ? new Date(r.oldest) : null,
      };
    } catch {
      return null;
    }
  }

  // -- maintenance mode --------------------------------------------------------------------

  async maintenance(tx: Executor = this.db): Promise<MaintenanceRow | undefined> {
    const [row] = await tx.select().from(maintenanceState).limit(1);
    return row;
  }

  async lockMaintenance(tx: Executor): Promise<MaintenanceRow | undefined> {
    const [row] = await tx.select().from(maintenanceState).for('update');
    return row;
  }

  async setMaintenance(
    tx: Executor,
    patch: {
      enabled: boolean;
      message: string | null;
      retryAfterSeconds: number;
      changedBy: string;
      changedAt: Date;
    }
  ): Promise<MaintenanceRow> {
    const [row] = await tx
      .update(maintenanceState)
      .set(patch)
      .where(eq(maintenanceState.id, true))
      .returning();
    if (!row) throw new Error('maintenance_state row is missing');
    return row;
  }

  async userRef(id: string | null, tx: Executor = this.db): Promise<string | null> {
    if (!id) return null;
    const [row] = await tx.select({ ref: users.ref }).from(users).where(eq(users.id, id)).limit(1);
    return row?.ref ?? null;
  }
}
