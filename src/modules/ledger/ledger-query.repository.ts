/**
 * Read-only queries behind the admin ledger routes (spec 7.3): accounts, entries, account
 * statements. Reads of partitioned journal tables always carry a `created_at` bound
 * (spec 9.2 rule 6). Nothing here writes; ledger.repository.ts stays the only writer.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import type { LedgerEnvironment } from '../accounts/domain/chart-of-accounts';
export interface EntryListRow {
  readonly id: string;
  readonly ref: string;
  readonly created_at: string;
  readonly environment: string;
  readonly currency: string;
  readonly source: string;
  readonly source_id: string;
  readonly kind: string;
  readonly description: string;
  readonly merchant_ref: string | null;
  readonly transaction_id: string | null;
  readonly reverses_entry_ref: string | null;
}
export interface StatementRow {
  readonly entry_id: string;
  readonly entry_ref: string;
  readonly created_at: string;
  readonly line_no: number;
  readonly direction: string;
  readonly amount_minor: string;
  readonly kind: string;
  readonly description: string;
  /** Running balance on the account's normal side, after this line. */
  readonly balance_after: string;
}
export interface EntryFilters {
  readonly environment?: LedgerEnvironment;
  readonly merchantId?: string;
  readonly source?: string;
  readonly transactionId?: string;
  readonly from: Date;
  readonly to: Date;
  /** Keyset: strictly older than (created_at, id). Microsecond text, as stored. */
  readonly after?: { readonly createdAt: string; readonly id: string };
}
@Injectable()
export class LedgerQueryRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}
  async listEntries(filters: EntryFilters, limit: number): Promise<EntryListRow[]> {
    const conditions = [
      sql`e.created_at >= ${filters.from.toISOString()}::timestamptz`,
      sql`e.created_at <= ${filters.to.toISOString()}::timestamptz`,
    ];
    if (filters.environment) conditions.push(sql`e.environment = ${filters.environment}`);
    if (filters.merchantId) conditions.push(sql`e.merchant_id = ${filters.merchantId}`);
    if (filters.source) conditions.push(sql`e.source = ${filters.source}`);
    if (filters.transactionId) conditions.push(sql`e.transaction_id = ${filters.transactionId}`);
    if (filters.after) {
      conditions.push(
        sql`(e.created_at < ${filters.after.createdAt}::timestamptz or (e.created_at = ${filters.after.createdAt}::timestamptz and e.id < ${filters.after.id}::uuid))`
      );
    }
    const result = await this.db.execute<EntryListRow & Record<string, unknown>>(sql`
      select e.id, e.ref, e.created_at::text as created_at, e.environment, e.currency, e.source,
             e.source_id, e.kind, e.description, m.ref as merchant_ref, e.transaction_id,
             r.entry_ref as reverses_entry_ref
        from core.journal_entries e
        left join core.merchants m on m.id = e.merchant_id
        left join core.journal_entry_keys r on r.entry_id = e.reverses_entry_id
       where ${sql.join(conditions, sql` and `)}
       order by e.created_at desc, e.id desc
       limit ${limit}`);
    return result.rows;
  }
  /**
   * The lines of one account and currency, oldest first, with the running balance after
   * each line. The window function runs over the account's whole history up to `to` so
   * the balance is exact; the outer filter then cuts the page. Admin-only, not a hot path.
   */
  async statement(input: {
    readonly accountId: string;
    readonly normalBalance: 'debit' | 'credit';
    readonly currency: string;
    readonly from: Date;
    readonly to: Date;
    readonly after?: { readonly createdAt: string; readonly key: string };
    readonly limit: number;
  }): Promise<StatementRow[]> {
    const sign = input.normalBalance === 'debit' ? sql`1` : sql`-1`;
    const afterCondition = input.after
      ? sql`and (created_ts, entry_key) > (${input.after.createdAt}::timestamptz, ${input.after.key})`
      : sql``;
    const result = await this.db.execute<StatementRow & Record<string, unknown>>(sql`
      select * from (
        select l.entry_id, e.ref as entry_ref, l.created_at::text as created_at, l.line_no,
               l.direction, l.amount_minor::text as amount_minor, e.kind, e.description,
               (sum(case when l.direction = 'debit' then l.amount_minor else -l.amount_minor end)
                  over (order by l.created_at, l.entry_id, l.line_no) * ${sign})::text as balance_after,
               l.created_at as created_ts,
               l.entry_id::text || ':' || lpad(l.line_no::text, 3, '0') as entry_key
          from core.journal_lines l
          join core.journal_entries e on e.id = l.entry_id and e.created_at = l.created_at
         where l.account_id = ${input.accountId} and l.currency = ${input.currency}
           and l.created_at <= ${input.to.toISOString()}::timestamptz
      ) s
       where created_ts >= ${input.from.toISOString()}::timestamptz ${afterCondition}
       order by created_ts, entry_key
       limit ${input.limit}`);
    return result.rows;
  }
}
