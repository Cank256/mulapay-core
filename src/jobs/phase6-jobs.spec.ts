import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { QUEUES } from '../common/queue/queue.definitions';
import { StatementUploadedHandler } from '../modules/reconciliation/statement-uploaded.handler';
import { SettlementSubmitHandler } from '../modules/settlement/settlement-submit.handler';
import {
  ReconciliationRunProcessor,
  StatementMatchProcessor,
} from './reconciliation-run.processor';
import { SettlementRunProcessor } from './settlement-run.processor';

const job = (name: string, data: unknown = {}) => ({ name, data }) as unknown as Job;
const row = (payload: Record<string, string>) => ({ payload }) as never;

describe('outbox handlers queue the right job, once', () => {
  it('queues the payout submission under a deterministic id', async () => {
    const jobs = await new SettlementSubmitHandler().handle({} as never, row({ batchId: 'b1' }));
    expect(jobs).toEqual([
      {
        queue: QUEUES.settlementRun.name,
        name: 'settlement.submit-payout',
        data: { batchId: 'b1' },
        options: { jobId: 'settlement_submit_b1' },
      },
    ]);
  });
  it('queues statement matching under a deterministic id', async () => {
    const jobs = await new StatementUploadedHandler().handle(
      {} as never,
      row({ statementId: 's1', statementRef: 'pst_1' })
    );
    expect(jobs).toEqual([
      {
        queue: QUEUES.statementMatch.name,
        name: 'statement.match',
        data: { statementRef: 'pst_1' },
        options: { jobId: 'statement_match_s1' },
      },
    ]);
  });
});

describe('processors route by job name and refuse others', () => {
  it('settlement-run', async () => {
    const tick = { tick: vi.fn().mockResolvedValue('ticked') };
    const release = { submitPayout: vi.fn().mockResolvedValue('submitted') };
    const p = new SettlementRunProcessor(tick as never, release as never);
    expect(await p.process(job('settlement.tick'))).toBe('ticked');
    expect(await p.process(job('settlement.submit-payout', { batchId: 'b1' }))).toBe('submitted');
    expect(release.submitPayout).toHaveBeenCalledWith('b1');
    await expect(p.process(job('nope'))).rejects.toThrow(/unknown settlement-run job/);
  });
  it('reconciliation-run', async () => {
    const scheduler = { runScheduled: vi.fn().mockResolvedValue({ outcome: 'completed' }) };
    const p = new ReconciliationRunProcessor(scheduler as never);
    await p.process(job('reconciliation.gateway-gap'));
    await p.process(job('reconciliation.ledger-integrity'));
    await p.process(job('reconciliation.balance-proof'));
    expect(scheduler.runScheduled.mock.calls.map((c) => c[0])).toEqual([
      'gateway_gap',
      'ledger_integrity',
      'balance_proof',
    ]);
    await expect(p.process(job('nope'))).rejects.toThrow(/unknown reconciliation-run job/);
  });
  it('statement-match', async () => {
    const scheduler = { runStatementMatch: vi.fn().mockResolvedValue({ outcome: 'duplicate' }) };
    const p = new StatementMatchProcessor(scheduler as never);
    expect(await p.process(job('statement.match', { statementRef: 'pst_1' }))).toBe('duplicate');
    expect(scheduler.runStatementMatch).toHaveBeenCalledWith('pst_1');
    await expect(p.process(job('nope'))).rejects.toThrow(/unknown statement-match job/);
  });
});
