/**
 * Streams a report's rows out of PostgreSQL through a server-side cursor (spec 6.12, 9.2): the
 * query runs once, in a read-only REPEATABLE READ transaction on the replica pool, and the rows
 * are fetched `batchSize` at a time with `FETCH FORWARD`. A report of any size therefore holds at
 * most one batch of rows in memory, and sees one consistent snapshot of the data.
 *
 * The transaction stays open between batches, while the caller writes each batch to object
 * storage, so its idle-in-transaction limit is raised for this transaction only (`SET LOCAL`,
 * which is safe behind PgBouncer's transaction mode), to `IDLE_LIMIT_MS`. The statement timeout
 * still applies to each fetch.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { DatabasePools } from '../../common/db/pools';
import { DB_POOLS } from '../../common/db/tokens';
import type { BuiltQuery } from './report-queries';

const IDLE_LIMIT_MS = 10 * 60 * 1000;

export type StreamedRow = ReadonlyArray<string | null>;

@Injectable()
export class ReportStreamRepository {
  constructor(@Inject(DB_POOLS) private readonly pools: DatabasePools) {}

  /** Yields batches of rows. Always releases the connection, even if the consumer stops early. */
  async *batches(query: BuiltQuery, batchSize: number): AsyncGenerator<StreamedRow[], void, void> {
    const client = await this.pools.replica.connect();
    let open = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      open = true;
      await client.query("select set_config('idle_in_transaction_session_timeout', $1, true)", [
        String(IDLE_LIMIT_MS),
      ]);
      await client.query({
        text: `DECLARE report_cursor NO SCROLL CURSOR FOR ${query.text}`,
        values: query.values,
      });
      for (;;) {
        const result = await client.query<Array<string | null>>({
          text: `FETCH FORWARD ${Math.trunc(batchSize)} FROM report_cursor`,
          rowMode: 'array',
        });
        if (result.rows.length === 0) break;
        yield result.rows;
        if (result.rows.length < batchSize) break;
      }
    } finally {
      if (open) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }
}
