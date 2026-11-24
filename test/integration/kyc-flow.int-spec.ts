/**
 * KYC (spec 6.13, Phase 7): a merchant moves through the levels to active with its limits
 * raised atomically; a rejection gives structured reasons and can be answered; an information
 * request reopens the submission; approval is refused without separation of duties, without
 * verified requirements and without clear screenings; KYC expires and is re-verified.
 *
 * Real Postgres and Redis; real S3 and screening adapters against in-process servers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/common/audit/audit.service';
import { MerchantEventsService } from '../../src/modules/events/merchant-events.service';
import {
  addTeamMember,
  loginMerchantUser,
  registerMerchantUser,
  staffSession,
} from '../support/identity';
import { sql } from '../support/payments';
import {
  activateThroughKyc,
  approveKyc,
  FILES,
  merchantReadyForLevel1,
  putProfile,
  reviewers,
  runScreening,
  submitKyc,
  uploadDocument,
  verifyEverything,
  startComplianceContext,
  type ComplianceContext,
} from '../support/compliance';

let ctx: ComplianceContext;
beforeAll(async () => {
  ctx = await startComplianceContext();
});
afterAll(async () => {
  await ctx?.close();
});

const DAY_MS = 86_400_000;

async function merchantOf(ref: string) {
  const [row] = await sql<{ id: string; status: string; kyc_level: number }>(
    'select id, status, kyc_level from core.merchants where ref = $1',
    [ref]
  );
  if (!row) throw new Error(`merchant ${ref} not found`);
  return row;
}

async function profileOf(merchantId: string) {
  const [row] = await sql<{
    status: string;
    level: number;
    submission_no: number;
    expires_at: Date | null;
    next_review_at: Date | null;
    rejection_reasons: string[] | null;
  }>(
    `select status, level, submission_no, expires_at, next_review_at, rejection_reasons
       from core.kyc_profiles where merchant_id = $1`,
    [merchantId]
  );
  return row;
}

const limitsOf = (merchantId: string) =>
  sql<{ currency: string; per_txn_max_minor: string; source: string; kyc_level: number }>(
    `select currency, per_txn_max_minor::text, source, kyc_level
       from core.merchant_limits where merchant_id = $1 order by currency`,
    [merchantId]
  );

const eventTypes = async (merchantId: string) =>
  (
    await sql<{ type: string }>(
      'select type from core.merchant_events where merchant_id = $1 order by created_at',
      [merchantId]
    )
  ).map((r) => r.type);

const auditActions = async (merchantId: string) =>
  (
    await sql<{ action: string }>(
      'select action from core.audit_logs where merchant_id = $1 order by seq',
      [merchantId]
    )
  ).map((r) => r.action);

/** A merchant that has submitted level 1, been screened and had its documents verified. */
async function readyForApproval(label: string) {
  const { owner, identity } = await merchantReadyForLevel1(ctx, label);
  expect((await submitKyc(owner)).statusCode).toBe(200);
  await runScreening(ctx, owner.merchantId);
  const staff = await reviewers(ctx);
  await verifyEverything(staff.maker, owner.merchantId, [identity]);
  return { owner, identity, staff };
}

describe('KYC progression (exit criterion)', () => {
  it('moves a merchant from sign-up to active and raises its limits in one step', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'progress');
    const before = await merchantOf(owner.merchantId);
    expect(before).toMatchObject({ status: 'draft', kyc_level: 0 });
    expect(await limitsOf(before.id)).toEqual([]);

    // Level 0 is test mode only: a live key cannot be issued yet.
    const early = await owner.client.post('/merchant/v1/api-keys', {
      name: 'live',
      environment: 'live',
      scopes: ['payments:read'],
    });
    expect(early.statusCode).toBeGreaterThanOrEqual(400);

    const status = (await owner.client.get('/merchant/v1/kyc')).json().data;
    expect(status).toMatchObject({
      level: 0,
      status: 'not_started',
      targetLevel: 1,
      canSubmit: true,
    });
    expect(status.requirements.map((r: { code: string }) => r.code)).toEqual([
      'business_type',
      'identity_document',
      'contact_verification',
    ]);

    const submit = await submitKyc(owner);
    expect(submit.json().data).toMatchObject({
      kind: 'initial',
      level: 1,
      submissionNo: 1,
      merchantStatus: 'pending_kyc',
    });
    expect(await merchantOf(owner.merchantId)).toMatchObject({
      status: 'pending_kyc',
      kyc_level: 0,
    });
    expect((await submitKyc(owner)).json().error.code).toBe('KYC_NOT_ALLOWED');

    const staff = await reviewers(ctx);
    // Nothing is verified yet.
    const tooEarly = await approveKyc(staff.checker, owner.merchantId);
    expect(tooEarly.json().error.code).toBe('KYC_REQUIREMENTS_NOT_MET');
    expect(tooEarly.json().error.details.unmet).toEqual([
      'identity_document',
      'contact_verification',
    ]);

    await verifyEverything(staff.maker, owner.merchantId, [identity]);
    // Everything is verified, but nobody has screened the merchant.
    const unscreened = await approveKyc(staff.checker, owner.merchantId);
    expect(unscreened.json().error.code).toBe('KYC_SCREENING_REQUIRED');
    expect(unscreened.json().error.details.pending).toEqual([owner.merchantId]);
    expect(await merchantOf(owner.merchantId)).toMatchObject({
      status: 'pending_kyc',
      kyc_level: 0,
    });

    await runScreening(ctx, owner.merchantId);
    const approved = await approveKyc(staff.checker, owner.merchantId);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toEqual({
      merchant: owner.merchantId,
      status: 'active',
      level: 1,
    });

    const after = await merchantOf(owner.merchantId);
    expect(after).toMatchObject({ status: 'active', kyc_level: 1 });
    const profile = await profileOf(after.id);
    expect(profile).toMatchObject({ status: 'approved', level: 1 });
    const validityMs = (profile?.expires_at?.getTime() ?? 0) - Date.now();
    expect(validityMs).toBeGreaterThan(360 * DAY_MS);
    expect(validityMs).toBeLessThan(366 * DAY_MS);
    expect(profile?.next_review_at && profile.expires_at).toBeTruthy();

    // The limits of level 1 are the merchant's limits, copied from the level data.
    const limits = await limitsOf(after.id);
    const levelData = await sql<{ currency: string; per_txn_max_minor: string }>(
      `select currency, per_txn_max_minor::text from core.kyc_level_limits
        where level = 1 and applies_when = 'approved' order by currency`
    );
    expect(limits.length).toBe(levelData.length);
    expect(limits.every((l) => l.source === 'kyc' && l.kyc_level === 1)).toBe(true);
    expect(limits.map((l) => [l.currency, l.per_txn_max_minor])).toEqual(
      levelData.map((l) => [l.currency, l.per_txn_max_minor])
    );

    expect(await eventTypes(after.id)).toEqual(
      expect.arrayContaining(['kyc.approved', 'merchant.activated'])
    );
    expect(await auditActions(after.id)).toEqual(
      expect.arrayContaining(['kyc.submitted', 'kyc.document.verified', 'kyc.approved'])
    );

    // The merchant can now take live keys.
    const live = await owner.client.post('/merchant/v1/api-keys', {
      name: 'live',
      environment: 'live',
      scopes: ['payments:read'],
    });
    expect(live.statusCode).toBe(201);
  });

  it('goes on to level 2 and level 3, each raising the limits, with the data-driven requirements', async () => {
    const { owner, merchantRef, staff } = await activateThroughKyc(ctx, 'ladder');
    const merchant = await merchantOf(merchantRef);
    const level1 = (await limitsOf(merchant.id)).find((l) => l.currency === 'UGX');

    // Level 2 for a Ugandan limited company asks for a TIN certificate; nothing is hard-coded.
    const need = (await owner.client.get('/merchant/v1/kyc/requirements?level=2')).json().data;
    const codes = need.requirements.map((r: { code: string }) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'registration_number',
        'business_registration_certificate',
        'tin',
        'tin_certificate',
        'proof_of_address',
        'bank_account',
      ])
    );
    // What level 1 verified is not asked again.
    expect(
      need.requirements.find((r: { code: string }) => r.code === 'identity_document').state
    ).toBe('verified');

    const incomplete = await submitKyc(owner, 2);
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().error.code).toBe('KYC_REQUIREMENTS_INCOMPLETE');
    expect(incomplete.json().error.details.missing).toEqual(
      expect.arrayContaining(['registration_number', 'tin', 'tin_certificate'])
    );

    await putProfile(owner, { registrationNumber: 'UG-80020001', tin: '1000123456' });
    const documents = [
      await uploadDocument(owner, 'business_registration_certificate'),
      await uploadDocument(owner, 'tin_certificate'),
      await uploadDocument(owner, 'proof_of_address', FILES.png(), 'image/png'),
    ];
    expect((await submitKyc(owner, 2)).json().data).toMatchObject({
      kind: 'upgrade',
      level: 2,
      merchantStatus: 'active',
    });
    await runScreening(ctx, merchantRef);
    // Active merchants keep trading while an upgrade is reviewed.
    expect((await merchantOf(merchantRef)).status).toBe('active');
    const reviewer = await staffSession(ctx, 'compliance');
    const approver = await staffSession(ctx, 'compliance');
    await verifyEverything(reviewer, merchantRef, documents, ['bank_account']);
    expect((await approveKyc(approver, merchantRef)).statusCode).toBe(200);
    const level2 = (await limitsOf(merchant.id)).find((l) => l.currency === 'UGX');
    expect(await merchantOf(merchantRef)).toMatchObject({ status: 'active', kyc_level: 2 });
    expect(BigInt(level2?.per_txn_max_minor ?? '0')).toBeGreaterThan(
      BigInt(level1?.per_txn_max_minor ?? '0')
    );
    expect(level2?.kyc_level).toBe(2);

    // Level 3: directors, a beneficial owner and a source of funds statement.
    await owner.client.post('/merchant/v1/kyc/parties', {
      kind: 'director',
      fullName: 'Amina Director',
      dateOfBirth: '1980-04-02',
      nationality: 'UG',
      idNumber: 'CM80012345678',
    });
    await owner.client.post('/merchant/v1/kyc/parties', {
      kind: 'ubo',
      fullName: 'Okello Owner',
      nationality: 'UG',
      ownershipBps: 6000,
    });
    const funds = await uploadDocument(owner, 'source_of_funds_statement');
    expect((await submitKyc(owner)).json().data).toMatchObject({ kind: 'upgrade', level: 3 });
    ctx.sanctions.respond('Okello Owner', [
      { id: 'NK-weak', caption: 'Okello Ownerson', score: 0.8, topics: ['sanction'] },
    ]);
    const results = await runScreening(ctx, merchantRef);
    expect(results.map((r) => r.status).sort()).toEqual(['clear', 'clear', 'potential_match']);
    await verifyEverything(reviewer, merchantRef, [funds], []);
    // A potential match stops the approval until an analyst decides it.
    const blocked = await approveKyc(approver, merchantRef);
    expect(blocked.json().error.code).toBe('KYC_SCREENING_MATCH');
    expect((await merchantOf(merchantRef)).kyc_level).toBe(2);

    const potential = (
      await reviewer.client.get(
        `/admin/v1/aml/screenings?merchant=${merchantRef}&status=potential_match`
      )
    ).json().data.items[0];
    const decided = await reviewer.client.post(`/admin/v1/aml/screenings/${potential.id}/decide`, {
      decision: 'clear',
      note: 'Different person: date of birth and nationality do not match.',
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().data.status).toBe('clear');
    expect((await approveKyc(approver, merchantRef)).statusCode).toBe(200);
    expect(await merchantOf(merchantRef)).toMatchObject({ status: 'active', kyc_level: 3 });
    const level3 = (await limitsOf(merchant.id)).find((l) => l.currency === 'UGX');
    expect(BigInt(level3?.per_txn_max_minor ?? '0')).toBeGreaterThan(
      BigInt(level2?.per_txn_max_minor ?? '0')
    );
    // The first reviewer's decisions stand; no staff session was needed beyond these three.
    expect(staff.maker.admin.userId).not.toBe(reviewer.admin.userId);
  });

  it('keeps personal data of directors out of the database, the API and the audit trail', async () => {
    const { owner, merchantRef } = await activateThroughKyc(ctx, 'pii');
    await owner.client.post('/merchant/v1/kyc/parties', {
      kind: 'director',
      fullName: 'Zed Secretperson',
      dateOfBirth: '1971-01-01',
      idNumber: 'ID-987654321',
    });
    const stored = await sql<{
      full_name_enc: string;
      id_number_enc: string;
      id_number_hmac: string;
    }>(
      `select p.full_name_enc, p.id_number_enc, p.id_number_hmac from core.kyc_parties p
         join core.merchants m on m.id = p.merchant_id where m.ref = $1`,
      [merchantRef]
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.full_name_enc).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain('Secretperson');
    expect(JSON.stringify(stored)).not.toContain('987654321');
    expect(stored[0]?.id_number_hmac).toMatch(/^[0-9a-f]{64}$/);

    const listed = (await owner.client.get('/merchant/v1/kyc/parties')).json().data.items[0];
    expect(listed).toMatchObject({ fullName: 'Zed Secretperson', idNumberLast4: '4321' });
    expect(JSON.stringify(listed)).not.toContain('ID-987654321');

    const audit = await sql<{ after: unknown }>(
      `select after from core.audit_logs a join core.merchants m on m.id = a.merchant_id
        where m.ref = $1 and a.action like 'kyc.party.%'`,
      [merchantRef]
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain('Secretperson');
    expect(JSON.stringify(audit)).not.toContain('987654321');
  });
});

describe('rejected KYC', () => {
  it('rejects with structured reasons, leaves the merchant unactivated and accepts a corrected resubmission', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'rejected');
    await submitKyc(owner);
    await runScreening(ctx, owner.merchantId);
    const staff = await reviewers(ctx);

    const noReasons = await staff.maker.client.post(`/admin/v1/kyc/${owner.merchantId}/reject`, {
      reasons: [],
    });
    expect(noReasons.statusCode).toBe(400);
    const unknown = await staff.maker.client.post(`/admin/v1/kyc/${owner.merchantId}/reject`, {
      reasons: [{ code: 'because_i_said_so' }],
    });
    expect(unknown.statusCode).toBe(400);

    const rejected = await staff.maker.client.post(`/admin/v1/kyc/${owner.merchantId}/reject`, {
      reasons: [
        { code: 'illegible', target: identity.id, note: 'The photo is too dark to read.' },
        { code: 'contact_not_verified' },
      ],
      note: 'Please send a clearer scan.',
    });
    expect(rejected.statusCode).toBe(200);

    const status = (await owner.client.get('/merchant/v1/kyc')).json().data;
    expect(status.status).toBe('rejected');
    expect(status.rejection.reasons).toEqual(['illegible', 'contact_not_verified']);
    expect(status.rejection.details[0]).toMatchObject({ code: 'illegible', target: identity.id });
    const merchant = await merchantOf(owner.merchantId);
    expect(merchant).toMatchObject({ status: 'pending_kyc', kyc_level: 0 });
    expect(await limitsOf(merchant.id)).toEqual([]);
    expect(await eventTypes(merchant.id)).toContain('kyc.rejected');
    expect(await auditActions(merchant.id)).toContain('kyc.rejected');

    // A rejected submission cannot be approved or rejected again.
    expect((await approveKyc(staff.checker, owner.merchantId)).json().error.code).toBe(
      'KYC_NOT_ALLOWED'
    );

    // The merchant corrects it and applies again.
    const better = await uploadDocument(owner, 'national_id', FILES.png(), 'image/png');
    const again = await submitKyc(owner);
    expect(again.json().data).toMatchObject({ kind: 'initial', submissionNo: 2 });
    await runScreening(ctx, owner.merchantId);
    await verifyEverything(staff.maker, owner.merchantId, [better]);
    // The first document was never reviewed, so identity is covered by the verified second one.
    expect((await approveKyc(staff.checker, owner.merchantId)).statusCode).toBe(200);
    expect(await merchantOf(owner.merchantId)).toMatchObject({ status: 'active', kyc_level: 1 });
  });

  it('refuses to approve a document that staff rejected', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'doc-rejected');
    await submitKyc(owner);
    await runScreening(ctx, owner.merchantId);
    const staff = await reviewers(ctx);
    const noReason = await staff.maker.client.post(
      `/admin/v1/kyc/${owner.merchantId}/documents/${identity.id}/verify`,
      { decision: 'reject' }
    );
    expect(noReason.statusCode).toBe(400);
    const rejected = await staff.maker.client.post(
      `/admin/v1/kyc/${owner.merchantId}/documents/${identity.id}/verify`,
      { decision: 'reject', reason: 'expired', note: 'The ID expired in 2022.' }
    );
    expect(rejected.json().data).toMatchObject({ status: 'rejected', rejectionReason: 'expired' });
    // A reviewed document is final.
    const again = await staff.maker.client.post(
      `/admin/v1/kyc/${owner.merchantId}/documents/${identity.id}/verify`,
      { decision: 'verify' }
    );
    expect(again.json().error.code).toBe('KYC_NOT_ALLOWED');
    await staff.maker.client.post(`/admin/v1/kyc/${owner.merchantId}/checks`, {
      checkType: 'contact',
      status: 'passed',
    });
    const approved = await approveKyc(staff.checker, owner.merchantId);
    expect(approved.json().error.code).toBe('KYC_REQUIREMENTS_NOT_MET');
    expect(approved.json().error.details.unmet).toEqual(['identity_document']);
  });
});

describe('request for information', () => {
  it('reopens the submission for the merchant to answer, then returns it to review', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'info');
    await submitKyc(owner);
    const staff = await reviewers(ctx);
    const asked = await staff.maker.client.post(`/admin/v1/kyc/${owner.merchantId}/request-info`, {
      note: 'Please add a utility bill.',
    });
    expect(asked.statusCode).toBe(200);

    const status = (await owner.client.get('/merchant/v1/kyc')).json().data;
    expect(status.status).toBe('in_review');
    expect(status.infoRequest.note).toBe('Please add a utility bill.');
    const merchant = await merchantOf(owner.merchantId);
    expect(await eventTypes(merchant.id)).toContain('kyc.info_requested');

    // While the request is open the merchant may add what was asked for.
    const extra = await uploadDocument(owner, 'other', FILES.pdf());
    expect(extra.id).toMatch(/^kdoc_/);
    const answer = await submitKyc(owner);
    expect(answer.json().data).toMatchObject({ kind: 'resubmission', submissionNo: 2 });
    expect((await owner.client.get('/merchant/v1/kyc')).json().data.status).toBe('pending');
  });

  it('does not let the merchant change a submission that is waiting for review', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'locked');
    await submitKyc(owner);
    const edit = await owner.client.put('/merchant/v1/kyc/profile', { registrationNumber: 'X-1' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.code).toBe('KYC_NOT_ALLOWED');
    const party = await owner.client.post('/merchant/v1/kyc/parties', {
      kind: 'director',
      fullName: 'Late Director',
    });
    expect(party.statusCode).toBe(409);
  });
});

describe('separation of duties and atomic activation', () => {
  it('refuses an approval by the person who verified the documents', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'maker-checker');
    await submitKyc(owner);
    await runScreening(ctx, owner.merchantId);
    const only = await staffSession(ctx, 'compliance');
    await verifyEverything(only, owner.merchantId, [identity]);
    const self = await approveKyc(only, owner.merchantId);
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('KYC_SEPARATION_OF_DUTIES');
    expect(await merchantOf(owner.merchantId)).toMatchObject({
      status: 'pending_kyc',
      kyc_level: 0,
    });
    const other = await staffSession(ctx, 'compliance');
    expect((await approveKyc(other, owner.merchantId)).statusCode).toBe(200);
  });

  it('applies nothing if any part of an approval fails', async () => {
    const { owner, staff } = await readyForApproval('atomic');
    const merchant = await merchantOf(owner.merchantId);
    const audit = ctx.app.get(AuditService, { strict: false });
    const original = audit.record.bind(audit);
    // The audit row is the last write of the approval: failing it must undo every write before it.
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (tx, entry) => {
      if (entry.action === 'kyc.approved') throw new Error('audit store unavailable');
      return original(tx, entry);
    });
    try {
      const failed = await approveKyc(staff.checker, owner.merchantId);
      expect(failed.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await merchantOf(owner.merchantId)).toMatchObject({
      status: 'pending_kyc',
      kyc_level: 0,
    });
    expect((await profileOf(merchant.id))?.status).toBe('in_review');
    expect(await limitsOf(merchant.id)).toEqual([]);
    expect(await eventTypes(merchant.id)).not.toContain('kyc.approved');
    expect(await eventTypes(merchant.id)).not.toContain('merchant.activated');
    const reviews = await sql<{ decision: string }>(
      `select r.decision from core.kyc_reviews r where r.merchant_id = $1`,
      [merchant.id]
    );
    expect(reviews.map((r) => r.decision)).not.toContain('approved');

    // The same approval, retried when the fault is gone, applies everything.
    expect((await approveKyc(staff.checker, owner.merchantId)).statusCode).toBe(200);
    expect(await merchantOf(owner.merchantId)).toMatchObject({ status: 'active', kyc_level: 1 });
    expect((await limitsOf(merchant.id)).length).toBeGreaterThan(0);
    expect(await eventTypes(merchant.id)).toEqual(
      expect.arrayContaining(['kyc.approved', 'merchant.activated'])
    );
  });

  it('also rolls back when announcing the approval to the merchant fails', async () => {
    const { owner, staff } = await readyForApproval('atomic-events');
    const merchant = await merchantOf(owner.merchantId);
    const events = ctx.app.get(MerchantEventsService, { strict: false });
    const spy = vi.spyOn(events, 'emit').mockRejectedValueOnce(new Error('outbox down'));
    try {
      expect((await approveKyc(staff.checker, owner.merchantId)).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await merchantOf(owner.merchantId)).toMatchObject({
      status: 'pending_kyc',
      kyc_level: 0,
    });
    expect(await limitsOf(merchant.id)).toEqual([]);
    expect((await profileOf(merchant.id))?.status).toBe('in_review');
  });
});

describe('expiry and re-verification', () => {
  it('gives notice 30 days ahead once, accepts a renewal, and expires an unrenewed approval', async () => {
    const { owner, merchantRef, staff } = await activateThroughKyc(ctx, 'expiry');
    const merchant = await merchantOf(merchantRef);
    const approved = await profileOf(merchant.id);
    const nextReview = approved?.next_review_at?.getTime() ?? 0;
    const expiry = approved?.expires_at?.getTime() ?? 0;
    expect(expiry - nextReview).toBe(30 * DAY_MS);

    // Before the notice date nothing happens.
    expect(await ctx.kycLifecycle.sweep()).toMatchObject({ notified: 0, expired: 0 });
    expect(await eventTypes(merchant.id)).not.toContain('kyc.reverification_due');

    // The notice is due: one event, once, however often the sweep runs.
    ctx.clock.set(new Date(nextReview + 60_000));
    const first = await ctx.kycLifecycle.sweep();
    expect(first.notified).toBeGreaterThanOrEqual(1);
    const second = await ctx.kycLifecycle.sweep();
    expect(second.notified).toBe(0);
    const notices = (await eventTypes(merchant.id)).filter((t) => t === 'kyc.reverification_due');
    expect(notices).toHaveLength(1);
    expect(await auditActions(merchant.id)).toContain('kyc.reverification_due');
    expect((await profileOf(merchant.id))?.status).toBe('approved');

    // The merchant renews. Everything is asked for again, and the old checks do not count.
    await loginMerchantUser(owner.client, owner.email);
    const renew = await submitKyc(owner);
    expect(renew.json().data).toMatchObject({
      kind: 'reverification',
      level: 1,
      merchantStatus: 'active',
    });
    await runScreening(ctx, merchantRef);
    const renewers = await reviewers(ctx);
    const stale = await approveKyc(renewers.checker, merchantRef);
    expect(stale.json().error.code).toBe('KYC_REQUIREMENTS_NOT_MET');
    expect(stale.json().error.details.unmet).toEqual(['contact_verification']);
    await renewers.maker.client.post(`/admin/v1/kyc/${merchantRef}/checks`, {
      checkType: 'contact',
      status: 'passed',
    });
    expect((await approveKyc(renewers.checker, merchantRef)).statusCode).toBe(200);
    const renewed = await profileOf(merchant.id);
    expect(renewed?.status).toBe('approved');
    expect((renewed?.expires_at?.getTime() ?? 0) - ctx.clock.now().getTime()).toBeGreaterThan(
      360 * DAY_MS
    );
    expect(staff.maker.admin.userId).toBeTruthy();
  });

  it('expires a profile that is not renewed, and applies the expiry limits where the data defines them', async () => {
    const { owner, merchantRef } = await activateThroughKyc(ctx, 'expired');
    const merchant = await merchantOf(merchantRef);
    // The spec defines no limit consequence of expiry, so none is seeded; this row stands in for a
    // policy that does. It is removed again below.
    await sql(
      `insert into core.kyc_level_limits (level, currency, applies_when, per_txn_max_minor,
         daily_volume_max_minor, monthly_volume_max_minor, payout_per_txn_max_minor, daily_payout_max_minor)
       values (1, 'ZMW', 'expired', 1000, 2000, 3000, 1000, 2000)
       on conflict do nothing`
    );
    try {
      const profile = await profileOf(merchant.id);
      ctx.clock.set(new Date((profile?.expires_at?.getTime() ?? 0) + 60_000));
      const swept = await ctx.kycLifecycle.sweep();
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      expect((await profileOf(merchant.id))?.status).toBe('expired');
      expect(await eventTypes(merchant.id)).toContain('kyc.expired');
      expect(await auditActions(merchant.id)).toContain('kyc.expired');
      // No policy is invented: the merchant keeps its status and level.
      expect(await merchantOf(merchantRef)).toMatchObject({ status: 'active', kyc_level: 1 });
      const reduced = (await limitsOf(merchant.id)).find((l) => l.currency === 'ZMW');
      expect(reduced?.per_txn_max_minor).toBe('1000');
      // Expiring twice does nothing more.
      expect((await ctx.kycLifecycle.sweep()).expired).toBe(0);

      // A renewal after expiry restores the approved limits.
      await loginMerchantUser(owner.client, owner.email);
      const renew = await submitKyc(owner);
      expect(renew.json().data.kind).toBe('reverification');
      await runScreening(ctx, merchantRef);
      const staff = await reviewers(ctx);
      await staff.maker.client.post(`/admin/v1/kyc/${merchantRef}/checks`, {
        checkType: 'contact',
        status: 'passed',
      });
      expect((await approveKyc(staff.checker, merchantRef)).statusCode).toBe(200);
      const restored = (await limitsOf(merchant.id)).find((l) => l.currency === 'ZMW');
      expect(BigInt(restored?.per_txn_max_minor ?? '0')).toBeGreaterThan(1000n);
    } finally {
      await sql(`delete from core.kyc_level_limits where applies_when = 'expired'`);
    }
  });
});

describe('authorization', () => {
  it('lets a viewer read KYC but not change it, and keeps merchants apart', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'authz');
    const other = await registerMerchantUser(ctx, 'bystander');
    const viewer = await addTeamMember(ctx, owner, 'viewer');
    expect((await viewer.client.get('/merchant/v1/kyc')).statusCode).toBe(200);
    expect((await viewer.client.post('/merchant/v1/kyc/submit', {})).statusCode).toBe(403);
    expect(
      (await viewer.client.put('/merchant/v1/kyc/profile', { tin: '123456' })).statusCode
    ).toBe(403);

    // Another merchant sees none of this merchant's documents, and nothing of its own yet.
    const mine = (await owner.client.get('/merchant/v1/kyc')).json().data;
    const theirs = (await other.client.get('/merchant/v1/kyc')).json().data;
    expect(mine.documents).toHaveLength(1);
    expect(theirs.documents).toEqual([]);

    // Merchant tokens do not open the admin surface, and staff without the permission are refused.
    expect((await owner.client.get('/admin/v1/kyc/queue')).statusCode).toBeGreaterThanOrEqual(401);
    const support = await staffSession(ctx, 'support_agent');
    expect((await support.client.get('/admin/v1/kyc/queue')).statusCode).toBe(200);
    expect(
      (
        await support.client.post(`/admin/v1/kyc/${owner.merchantId}/reject`, {
          reasons: [{ code: 'other' }],
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await support.client.post(`/admin/v1/kyc/${owner.merchantId}/approve`, {})).statusCode
    ).toBe(403);
  });

  it('lists the review queue for staff', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'queued');
    await submitKyc(owner);
    const staff = await staffSession(ctx, 'compliance');
    const queue = (await staff.client.get('/admin/v1/kyc/queue?limit=200')).json().data;
    const mine = queue.items.find((i: { merchant: string }) => i.merchant === owner.merchantId);
    expect(mine).toMatchObject({ status: 'pending', level: 1, submissionNo: 1 });
    const detail = (await staff.client.get(`/admin/v1/kyc/${owner.merchantId}`)).json().data;
    expect(detail.status.status).toBe('pending');
    expect(detail.reviews.map((r: { decision: string }) => r.decision)).toEqual(['submitted']);
    expect(
      (await staff.client.get('/admin/v1/kyc/mch_00000000000000000000000000')).statusCode
    ).toBe(404);
  });
});
