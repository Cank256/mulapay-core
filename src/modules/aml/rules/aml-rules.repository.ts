/** SQL for `core.aml_rules` and its append-only version history. */
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import { amlRules, amlRuleVersions } from '../../../db/schema';

export type RuleRow = typeof amlRules.$inferSelect;
export type NewRule = typeof amlRules.$inferInsert;
export type RulePatch = Partial<
  Pick<
    NewRule,
    | 'name'
    | 'description'
    | 'params'
    | 'severity'
    | 'action'
    | 'enabled'
    | 'effectiveFrom'
    | 'effectiveTo'
    | 'version'
    | 'updatedBy'
  >
>;

@Injectable()
export class AmlRulesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewRule): Promise<RuleRow> {
    const [row] = await tx.insert(amlRules).values(values).returning();
    if (!row) throw new Error('rule insert returned no row');
    return row;
  }

  async lockByCode(tx: Executor, code: string): Promise<RuleRow | undefined> {
    const [row] = await tx.select().from(amlRules).where(eq(amlRules.code, code)).for('update');
    return row;
  }

  async findByCode(code: string, tx: Executor = this.db): Promise<RuleRow | undefined> {
    const [row] = await tx.select().from(amlRules).where(eq(amlRules.code, code)).limit(1);
    return row;
  }

  async update(tx: Executor, id: string, patch: RulePatch): Promise<RuleRow> {
    const [row] = await tx.update(amlRules).set(patch).where(eq(amlRules.id, id)).returning();
    if (!row) throw new Error('rule update returned no row');
    return row;
  }

  list(tx: Executor = this.db): Promise<RuleRow[]> {
    return tx.select().from(amlRules).orderBy(asc(amlRules.code));
  }

  /** Enabled rules; the caller applies the effective dates for the transaction's own time. */
  listEnabled(tx: Executor): Promise<RuleRow[]> {
    return tx.select().from(amlRules).where(eq(amlRules.enabled, true)).orderBy(asc(amlRules.code));
  }

  async insertVersion(tx: Executor, values: typeof amlRuleVersions.$inferInsert): Promise<void> {
    await tx.insert(amlRuleVersions).values(values);
  }

  versions(ruleId: string, tx: Executor = this.db) {
    return tx
      .select()
      .from(amlRuleVersions)
      .where(eq(amlRuleVersions.ruleId, ruleId))
      .orderBy(asc(amlRuleVersions.version));
  }
}
