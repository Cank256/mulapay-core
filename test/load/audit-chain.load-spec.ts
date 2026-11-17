/**
 * How much write throughput the single audit hash chain allows (finding PERF-2).
 *
 * Every audited write takes `FOR UPDATE` on the one `audit_chain_head` row and holds it until its
 * transaction commits, so audited writes run one after another. This isolates that: N concurrent
 * workers each run a transaction that records one audit row and then does `HOLD_MS` of other work
 * before committing (what the real handlers do after the audit row, which is written last). The
 * measured rate is the ceiling the chain imposes for that much trailing work, independent of CPU.
 *
 * (Concurrency can help when there is no trailing work, because the single worker then waits on
 * its own commit; the property tested is the one with trailing work.)
 *
 * The numbers are about lock hand-over, not machine speed, so they are meaningful even on a loaded
 * host: with no trailing work the ceiling is the commit rate; each millisecond of trailing work in
 * the transaction removes a millisecond from every other writer.
 */
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/common/audit/audit.service';
import { UnitOfWork } from '../../src/common/db/unit-of-work';
import { startPaymentsContext, type PaymentsContext } from '../support/payments';

let ctx: PaymentsContext;
beforeAll(async () => {
  ctx = await startPaymentsContext({ DB_POOL_MAX: '40' });
});
afterAll(async () => {
  await ctx?.close();
});

async function run(workers: number, perWorker: number, holdMs: number) {
  const units = ctx.app.get(UnitOfWork, { strict: false });
  const audit = ctx.app.get(AuditService, { strict: false });
  const started = performance.now();
  const latencies: number[] = [];
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let i = 0; i < perWorker; i += 1) {
        const t0 = performance.now();
        await units.run(async (tx) => {
          await audit.record(tx, {
            action: 'load.probe',
            resourceType: 'probe',
            actor: { type: 'job', id: 'audit-chain-load', label: 'audit chain load' },
          });
          // The rest of the transaction after the audit row: a query that stands for the commit path.
          await tx.execute(sql`select pg_sleep(${holdMs / 1000})`);
        });
        latencies.push(performance.now() - t0);
      }
    })
  );
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    perSecond: (workers * perWorker) / seconds,
    p50: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p99: latencies[Math.floor(latencies.length * 0.99)] ?? 0,
  };
}

describe('audit chain throughput', () => {
  it('serialises audited writes: more workers do not raise the rate', async () => {
    const results: Record<string, { perSecond: number; p50: number; p99: number }> = {};
    for (const [workers, hold] of [
      [1, 0],
      [8, 0],
      [8, 5],
      [32, 5],
      [8, 20],
    ] as const) {
      results[`${workers} workers, ${hold} ms trailing work`] = await run(workers, 30, hold);
    }
    process.stdout.write(`AUDIT_CHAIN ${JSON.stringify(results, null, 2)}\n`);
    const heldEight = results['8 workers, 5 ms trailing work']?.perSecond ?? 0;
    const heldThirtyTwo = results['32 workers, 5 ms trailing work']?.perSecond ?? 0;
    const slow = results['8 workers, 20 ms trailing work']?.perSecond ?? 0;
    // With work after the audit row, four times the workers do not raise the rate: it is a queue.
    expect(heldThirtyTwo).toBeLessThan(heldEight * 1.5);
    // The ceiling is about 1 / (trailing work + commit): more trailing work, lower ceiling.
    expect(slow).toBeLessThan(heldEight);
    expect(heldEight).toBeLessThan(1000 / 5);
  }, 600_000);
});
