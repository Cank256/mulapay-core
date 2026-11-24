/**
 * The compliance jobs (spec 8.8, 8.9, Phase 7): screening and monitoring are queued through the
 * outbox, run by the `aml-screen` processor, and are idempotent: running a job twice has one
 * effect. Every sweep is safe to repeat.
 */
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metricsRegistry } from '../../src/common/telemetry/metrics';
import { AML_JOBS, AmlScreenProcessor } from '../../src/jobs/aml-screen.processor';
import { AmlMonitoringService } from '../../src/modules/aml/monitoring/aml-monitoring.service';
import { AML_MONITOR_JOB } from '../../src/modules/aml/monitoring/aml-monitoring.trigger';
import {
  KYC_SCREEN_JOB,
  KycScreeningRequestedHandler,
} from '../../src/modules/kyc/kyc-screening.handler';
import { KycScreeningService, screeningJobId } from '../../src/modules/kyc/kyc-screening.service';
import { KycLifecycleService } from '../../src/modules/kyc/kyc-lifecycle.service';
import { AmlAlertsService } from '../../src/modules/aml/alerts/aml-alerts.service';
import { AmlBlocklistService } from '../../src/modules/aml/blocklist/aml-blocklist.service';
import { KYC_SCREENING_OUTBOX_TYPE } from '../../src/modules/kyc/kyc-submission.service';
import { sql } from '../support/payments';
import {
  activeMerchant,
  merchantReadyForLevel1,
  startComplianceContext,
  submitKyc,
  succeedLivePayment,
  type ComplianceContext,
} from '../support/compliance';

let ctx: ComplianceContext;
let processor: AmlScreenProcessor;
beforeAll(async () => {
  ctx = await startComplianceContext();
  processor = new AmlScreenProcessor(
    ctx.app.get(KycScreeningService, { strict: false }),
    ctx.app.get(AmlMonitoringService, { strict: false }),
    ctx.app.get(AmlAlertsService, { strict: false }),
    ctx.app.get(AmlBlocklistService, { strict: false }),
    ctx.app.get(KycLifecycleService, { strict: false })
  );
});
afterAll(async () => {
  await ctx?.close();
});

const job = (name: string, data: unknown = {}) => ({ name, data }) as unknown as Job;

describe('screening is queued by the outbox when KYC is submitted', () => {
  it('writes one outbox row per submission, and turns it into one job per person', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'queued-screening');
    await owner.client.post('/merchant/v1/kyc/parties', {
      kind: 'director',
      fullName: 'Dina Director',
    });
    await owner.client.post('/merchant/v1/kyc/parties', {
      kind: 'ubo',
      fullName: 'Uma Owner',
      ownershipBps: 5000,
    });
    expect((await submitKyc(owner)).statusCode).toBe(200);

    const [profile] = await sql<{ id: string }>(
      `select p.id from core.kyc_profiles p join core.merchants m on m.id = p.merchant_id where m.ref = $1`,
      [owner.merchantId]
    );
    const rows = await sql<{ id: string; payload: { kycProfileId: string; submissionNo: number } }>(
      `select id, payload from core.outbox where event_type = $1 and payload ->> 'kycProfileId' = $2`,
      [KYC_SCREENING_OUTBOX_TYPE, profile?.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ kycProfileId: profile?.id, submissionNo: 1 });
    // Identifiers only: no names in the queue.
    expect(JSON.stringify(rows)).not.toContain('Dina');

    const handler = ctx.app.get(KycScreeningRequestedHandler, { strict: false });
    const jobs = await ctx.unitOfWork.run((tx) =>
      handler.handle(tx, { payload: rows[0]?.payload } as never)
    );
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.queue === 'aml-screen' && j.name === KYC_SCREEN_JOB)).toBe(true);
    const subjects = jobs.map((j) => (j.data as { subjectType: string }).subjectType).sort();
    expect(subjects).toEqual(['director', 'merchant', 'ubo']);
    for (const j of jobs) {
      expect(j.options?.jobId).toBe(screeningJobId(j.data as never));
    }
    expect(new Set(jobs.map((j) => j.options?.jobId)).size).toBe(3);
    expect(JSON.stringify(jobs)).not.toContain('Dina');

    // Running each job twice gives one screening each.
    for (const j of jobs) {
      await processor.process(job(KYC_SCREEN_JOB, j.data));
      await processor.process(job(KYC_SCREEN_JOB, j.data));
    }
    const screenings = await sql('select 1 from core.aml_screenings where kyc_profile_id = $1', [
      profile?.id,
    ]);
    expect(screenings).toHaveLength(3);
  });
});

describe('the aml-screen processor', () => {
  it('monitors a transaction once however many times the job runs', async () => {
    const m = await activeMerchant(ctx, 'job-monitor');
    const payment = await succeedLivePayment(ctx, m, { amountMinor: 1_000n, currency: 'UGX' });
    const first = await processor.process(
      job(AML_MONITOR_JOB, { transactionId: payment.transactionId })
    );
    const second = await processor.process(
      job(AML_MONITOR_JOB, { transactionId: payment.transactionId })
    );
    expect((first as { result: string }).result).toBe('monitored');
    expect((second as { result: string }).result).toBe('already_monitored');
    expect(
      await sql('select 1 from core.aml_transaction_facts where transaction_id = $1', [
        payment.transactionId,
      ])
    ).toHaveLength(1);
  });

  it('runs the sweeps and is safe to repeat them', async () => {
    const tick = (await processor.process(job(AML_JOBS.tick))) as {
      escalated: number;
      failed: number;
    };
    expect(tick.failed).toBe(0);
    const metrics = await metricsRegistry.getMetricsAsJSON();
    const gauge = metrics.find((m) => m.name === 'core_aml_alerts_open');
    expect(gauge).toBeDefined();
    const repeat = (await processor.process(job(AML_JOBS.tick))) as { escalated: number };
    expect(repeat.escalated).toBe(0);

    expect(await processor.process(job(AML_JOBS.blocklistRebuild))).toBeGreaterThanOrEqual(0);
    const lifecycle = (await processor.process(job(AML_JOBS.kycLifecycle))) as { failed: number };
    expect(lifecycle.failed).toBe(0);
    const again = (await processor.process(job(AML_JOBS.kycLifecycle))) as {
      notified: number;
      expired: number;
    };
    expect(again).toMatchObject({ notified: 0, expired: 0 });
  });

  it('refuses a job it does not know, without retrying it', async () => {
    await expect(processor.process(job('aml.nonsense'))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('exposes the compliance metrics', async () => {
    const text = await metricsRegistry.metrics();
    for (const name of [
      'core_aml_alerts_open',
      'core_aml_alert_sla_breaches_total',
      'core_aml_alerts_raised_total',
      'core_aml_precheck_duration_seconds',
      'core_aml_precheck_total',
      'core_kyc_decisions_total',
      'core_aml_screenings_total',
    ]) {
      expect(text, name).toContain(name);
    }
    // No personal data or free-text in any label.
    expect(text).not.toMatch(/core_aml_[a-z_]+\{[^}]*(msisdn|name|email)=/);
  });
});
