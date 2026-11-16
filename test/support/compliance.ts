/**
 * Fixtures for the compliance suites (Phase 7): the payments context pointed at an in-process
 * S3 and an in-process sanctions provider, so the real storage and screening adapters run over
 * HTTP; merchants that go through real KYC; staff sessions for the maker and the checker; and
 * helpers that upload documents the way a browser does (presign, PUT, confirm).
 *
 * Test files run in parallel against one database. Everything a test creates is its own
 * merchant, and AML rules use a currency no other suite uses, so a rule one test enables cannot
 * act on another suite's merchants.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'undici';
import { AppError } from '../../src/common/errors/app-error';
import { DB_RW } from '../../src/common/db/tokens';
import type { Executor } from '../../src/common/db/database.types';
import { BalancesService } from '../../src/modules/balances/balances.service';
import { HoldsService } from '../../src/modules/holds/holds.service';
import { AmlAlertsService } from '../../src/modules/aml/alerts/aml-alerts.service';
import { AmlBlockService } from '../../src/modules/aml/block/aml-block.service';
import { AmlBlocklistService } from '../../src/modules/aml/blocklist/aml-blocklist.service';
import { AmlCasesService } from '../../src/modules/aml/cases/aml-cases.service';
import { AmlStrExportService } from '../../src/modules/aml/cases/aml-str-export.service';
import { MerchantLimitsService } from '../../src/modules/aml/limits/merchant-limits.service';
import { AmlMonitoringService } from '../../src/modules/aml/monitoring/aml-monitoring.service';
import { AmlPrecheckService } from '../../src/modules/aml/precheck/precheck.service';
import { PayoutControlService } from '../../src/modules/aml/block/payout-control.service';
import { AmlRulesService } from '../../src/modules/aml/rules/aml-rules.service';
import { AmlScreeningService } from '../../src/modules/aml/screening/aml-screening.service';
import { DisputesService } from '../../src/modules/disputes/disputes.service';
import { KycLifecycleService } from '../../src/modules/kyc/kyc-lifecycle.service';
import { KycReviewService } from '../../src/modules/kyc/kyc-review.service';
import { KycScreeningService } from '../../src/modules/kyc/kyc-screening.service';
import { KycStatusService } from '../../src/modules/kyc/kyc-status.service';
import { KycProfilesRepository } from '../../src/modules/kyc/kyc-profiles.repository';
import { FAKE_S3, startFakeS3, type FakeS3 } from './fake-s3';
import { startFakeSanctions, type FakeSanctions } from './fake-sanctions';
import {
  Client,
  registerMerchantUser,
  staffSession,
  type MerchantUser,
  type StaffSession,
} from './identity';
import {
  applyEvent,
  createPayment,
  createTestMerchant,
  event,
  sql,
  startPaymentsContext,
  toProcessing,
  type PaymentsContext,
  type TestMerchant,
} from './payments';

export interface ComplianceContext extends PaymentsContext {
  readonly s3: FakeS3;
  readonly sanctions: FakeSanctions;
  readonly db: Executor;
  readonly balances: BalancesService;
  readonly holds: HoldsService;
  readonly review: KycReviewService;
  readonly kycScreening: KycScreeningService;
  readonly kycStatus: KycStatusService;
  readonly kycLifecycle: KycLifecycleService;
  readonly kycProfiles: KycProfilesRepository;
  readonly screening: AmlScreeningService;
  readonly monitoring: AmlMonitoringService;
  readonly alerts: AmlAlertsService;
  readonly cases: AmlCasesService;
  readonly str: AmlStrExportService;
  readonly rules: AmlRulesService;
  readonly blocklist: AmlBlocklistService;
  readonly blocks: AmlBlockService;
  readonly payoutControl: PayoutControlService;
  readonly precheck: AmlPrecheckService;
  readonly limits: MerchantLimitsService;
  readonly disputesService: DisputesService;
}

export async function startComplianceContext(
  overrides: Record<string, string> = {}
): Promise<ComplianceContext> {
  const [s3, sanctions] = await Promise.all([startFakeS3(), startFakeSanctions()]);
  const base = await startPaymentsContext({
    ...s3.config(),
    ...sanctions.config(),
    ...overrides,
  });
  const get = <T>(token: new (...args: never[]) => T): T => base.app.get(token, { strict: false });
  return {
    ...base,
    s3,
    sanctions,
    db: base.app.get<Executor>(DB_RW, { strict: false }),
    balances: get(BalancesService),
    holds: get(HoldsService),
    review: get(KycReviewService),
    kycScreening: get(KycScreeningService),
    kycStatus: get(KycStatusService),
    kycLifecycle: get(KycLifecycleService),
    kycProfiles: get(KycProfilesRepository),
    screening: get(AmlScreeningService),
    monitoring: get(AmlMonitoringService),
    alerts: get(AmlAlertsService),
    cases: get(AmlCasesService),
    str: get(AmlStrExportService),
    rules: get(AmlRulesService),
    blocklist: get(AmlBlocklistService),
    blocks: get(AmlBlockService),
    payoutControl: get(PayoutControlService),
    precheck: get(AmlPrecheckService),
    limits: get(MerchantLimitsService),
    disputesService: get(DisputesService),
    close: async () => {
      await base.close();
      await Promise.all([s3.close(), sanctions.close()]);
    },
  };
}

/** The first bytes of each allowed file type, padded so the file has some size. */
export const FILES = {
  pdf: (extra = 64) => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(extra)]),
  png: (extra = 64) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(extra),
    ]),
  jpeg: (extra = 64) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), randomBytes(extra)]),
  /** A Windows executable header: not a document, whatever it is called. */
  exe: (extra = 64) => Buffer.concat([Buffer.from('MZ\x90\x00', 'latin1'), randomBytes(extra)]),
};

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The values an upload is declared with. */
export function declare(type: string, bytes: Buffer, contentType: string) {
  return { type, contentType, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

/** PUTs `bytes` to a presigned upload exactly as a browser would, and returns the store's status. */
export async function putToStore(
  upload: { url: string; headers: Record<string, string> },
  bytes: Buffer
): Promise<number> {
  const res = await request(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
  await res.body.dump();
  return res.statusCode;
}

export interface UploadedDocument {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly bytes: Buffer;
}

/** Presign, upload and confirm one document. Throws if any step does not succeed. */
export async function uploadDocument(
  owner: MerchantUser,
  type: string,
  bytes: Buffer = FILES.pdf(),
  contentType = 'application/pdf'
): Promise<UploadedDocument> {
  const declared = declare(type, bytes, contentType);
  const presign = await owner.client.post('/dashboard/v1/kyc/documents/presign', declared);
  if (presign.statusCode !== 200) throw new Error(`presign failed: ${presign.body}`);
  const { documentId, upload } = presign.json().data as {
    documentId: string;
    upload: { url: string; headers: Record<string, string> };
  };
  const status = await putToStore(upload, bytes);
  if (status !== 200) throw new Error(`upload failed with ${status}`);
  const confirm = await owner.client.post('/dashboard/v1/kyc/documents', {
    ...declared,
    documentId,
  });
  if (confirm.statusCode !== 201) throw new Error(`confirm failed: ${confirm.body}`);
  return { id: confirm.json().data.id as string, type, status: 'uploaded', bytes };
}

export async function putProfile(owner: MerchantUser, body: Record<string, unknown>) {
  const res = await owner.client.put('/dashboard/v1/kyc/profile', body);
  if (res.statusCode !== 200) throw new Error(`profile failed: ${res.body}`);
  return res.json().data;
}

export async function submitKyc(owner: MerchantUser, level?: number) {
  return owner.client.post('/dashboard/v1/kyc/submit', level === undefined ? {} : { level });
}

/** A fresh merchant (draft, country UG) that has done everything level 1 asks of the merchant. */
export async function merchantReadyForLevel1(
  ctx: ComplianceContext,
  label = 'kyc'
): Promise<{ owner: MerchantUser; identity: UploadedDocument }> {
  const owner = await registerMerchantUser(ctx, label);
  await putProfile(owner, { businessType: 'limited_company' });
  const identity = await uploadDocument(owner, 'national_id', FILES.jpeg(), 'image/jpeg');
  return { owner, identity };
}

/** Runs the screening jobs a submission queued, as the `aml-screen` worker would. */
export async function runScreening(ctx: ComplianceContext, merchantRef: string) {
  const merchant = await ctx.merchants.findByRef(merchantRef);
  if (!merchant) throw new Error(`merchant ${merchantRef} not found`);
  const profile = await ctx.kycProfiles.findByMerchant(merchant.id);
  if (!profile) throw new Error('merchant has no KYC profile');
  const jobs = await ctx.kycScreening.subjectJobs(ctx.db, profile.id, profile.submissionNo);
  const results = [];
  for (const job of jobs) results.push(await ctx.kycScreening.screenSubject(job));
  return results;
}

export interface Reviewers {
  readonly maker: StaffSession;
  readonly checker: StaffSession;
}

/** Two different compliance staff: one reviews, the other approves. */
export async function reviewers(ctx: ComplianceContext): Promise<Reviewers> {
  return {
    maker: await staffSession(ctx, 'compliance'),
    checker: await staffSession(ctx, 'compliance'),
  };
}

/** Verifies every uploaded document of a merchant and records the staff-side checks given. */
export async function verifyEverything(
  maker: StaffSession,
  merchantRef: string,
  documents: readonly UploadedDocument[],
  checks: readonly string[] = ['contact']
) {
  for (const doc of documents) {
    const res = await maker.client.post(`/admin/v1/kyc/${merchantRef}/documents/${doc.id}/verify`, {
      decision: 'verify',
    });
    if (res.statusCode !== 200) throw new Error(`verify failed: ${res.body}`);
  }
  for (const checkType of checks) {
    const res = await maker.client.post(`/admin/v1/kyc/${merchantRef}/checks`, {
      checkType,
      status: 'passed',
    });
    if (res.statusCode !== 200) throw new Error(`check failed: ${res.body}`);
  }
}

export async function approveKyc(checker: StaffSession, merchantRef: string) {
  return checker.client.post(`/admin/v1/kyc/${merchantRef}/approve`, {});
}

/** Takes a merchant from draft to active at level 1 through the real flow. */
export async function activateThroughKyc(
  ctx: ComplianceContext,
  label = 'activated'
): Promise<{ owner: MerchantUser; merchantRef: string; staff: Reviewers }> {
  const { owner, identity } = await merchantReadyForLevel1(ctx, label);
  const submit = await submitKyc(owner);
  if (submit.statusCode !== 200) throw new Error(`submit failed: ${submit.body}`);
  await runScreening(ctx, owner.merchantId);
  const staff = await reviewers(ctx);
  await verifyEverything(staff.maker, owner.merchantId, [identity]);
  const approved = await approveKyc(staff.checker, owner.merchantId);
  if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);
  return { owner, merchantRef: owner.merchantId, staff };
}

export async function errorCodeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return error instanceof AppError
      ? error.code
      : error instanceof Error
        ? error.name
        : String(error);
  }
}

/** A currency and phone number prefix for one suite's live money, so rules cannot cross suites. */
export const uniqueMsisdn = () => `+2567${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

export interface LivePayment {
  readonly ref: string;
  readonly id: string;
  readonly transactionId: string;
}

/**
 * Creates a live payment and drives it to `succeeded`, as the gateway consumer will. The
 * merchant must be active with a live key. Returns the ids monitoring needs.
 */
export async function succeedLivePayment(
  ctx: PaymentsContext,
  merchant: TestMerchant,
  options: { amountMinor: bigint; currency: string; msisdn?: string; provider?: 'mtn' | 'airtel' }
): Promise<LivePayment> {
  const live = merchant.live;
  if (!live) throw new Error('merchant has no live key');
  const provider = options.provider ?? 'mtn';
  const created = await createPayment(live, {
    amountMinor: options.amountMinor.toString(),
    currency: options.currency,
    paymentMethod: { provider, msisdn: options.msisdn ?? uniqueMsisdn() },
  });
  const detail = await ctx.paymentsRepository.findDetailByRef(merchant.scope('live'), created.id);
  if (!detail) throw new Error(`payment ${created.id} not found`);
  await toProcessing(ctx, detail.payment.id, { identifiers: { provider } });
  const done = await applyEvent(
    ctx,
    detail.payment.id,
    event(
      { kind: 'succeeded', amountMinor: options.amountMinor, currency: options.currency },
      { identifiers: { provider, providerTransactionId: `P-${randomUUID().slice(0, 12)}` } }
    )
  );
  if (done.result !== 'applied')
    throw new Error(`payment did not succeed: ${JSON.stringify(done)}`);
  return { ref: created.id, id: detail.payment.id, transactionId: done.transactionId };
}

/** An active live merchant (by SQL, as the existing suites do) with a live key. */
export function activeMerchant(ctx: PaymentsContext, label = 'live'): Promise<TestMerchant> {
  return createTestMerchant(ctx, { active: true, label });
}

export { Client, sql, FAKE_S3 };
