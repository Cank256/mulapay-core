/**
 * KYC documents, requirements data and onboarding screening (spec 6.13): uploads go straight
 * to object storage and are validated by magic bytes; admin viewing is short-lived and
 * audited; requirements are rows, not code; sanctions and PEP matches stop activation and open
 * a case; a screening provider that does not answer blocks rather than clears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'undici';
import { OpenSanctionsScreening } from '../../src/integrations/sanctions/opensanctions-screening';
import { ScreeningUnavailableError } from '../../src/integrations/sanctions/sanctions-screening.port';
import { Client, registerMerchantUser, staffSession } from '../support/identity';
import { sql } from '../support/payments';
import {
  approveKyc,
  declare,
  errorCodeOf,
  FAKE_S3,
  FILES,
  merchantReadyForLevel1,
  putToStore,
  reviewers,
  runScreening,
  sha256,
  startComplianceContext,
  submitKyc,
  uploadDocument,
  verifyEverything,
  type ComplianceContext,
} from '../support/compliance';

let ctx: ComplianceContext;
beforeAll(async () => {
  ctx = await startComplianceContext();
});
afterAll(async () => {
  await ctx?.close();
});

async function merchantId(ref: string): Promise<string> {
  const [row] = await sql<{ id: string }>('select id from core.merchants where ref = $1', [ref]);
  if (!row) throw new Error('merchant not found');
  return row.id;
}

const keyOf = (merchantUuid: string, documentId: string) =>
  `${FAKE_S3.documents}/kyc/${merchantUuid}/${documentId}`;

async function rowsFor(merchantUuid: string) {
  return sql<{ ref: string; status: string }>(
    'select ref, status from core.kyc_documents where merchant_id = $1',
    [merchantUuid]
  );
}

/** Presigns, uploads `bytes` as given and confirms with the declaration, returning the confirm response. */
async function tryUpload(
  owner: { client: Client },
  declared: ReturnType<typeof declare>,
  bytes: Buffer
) {
  const presign = await owner.client.post('/merchant/v1/kyc/documents/presign', declared);
  expect(presign.statusCode).toBe(200);
  const { documentId, upload } = presign.json().data;
  const stored = await putToStore(upload, bytes);
  const confirm = await owner.client.post('/merchant/v1/kyc/documents', {
    ...declared,
    documentId,
  });
  return { documentId, stored, confirm };
}

describe('document upload', () => {
  it('stores the file in object storage, never the database, with encryption and a verified checksum', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'upload');
    const uuid = await merchantId(owner.merchantId);
    const bytes = FILES.pdf(500);
    const before = ctx.s3.requests.length;
    const doc = await uploadDocument(owner, 'proof_of_address', bytes);

    const stored = ctx.s3.objects.get(keyOf(uuid, doc.id));
    expect(stored?.body.equals(bytes)).toBe(true);
    expect(stored?.contentType).toBe('application/pdf');
    expect(stored?.encryption).toBe('AES256');

    const [row] = await sql<{
      file_key: string;
      file_hash: string;
      mime: string;
      size_bytes: string;
      status: string;
    }>(
      'select file_key, file_hash, mime, size_bytes::text, status from core.kyc_documents where ref = $1',
      [doc.id]
    );
    expect(row).toMatchObject({
      file_key: `kyc/${uuid}/${doc.id}`,
      file_hash: sha256(bytes),
      mime: 'application/pdf',
      size_bytes: String(bytes.length),
      status: 'uploaded',
    });

    // Core's own requests were a HEAD and a read of the first 16 bytes. It never fetched the file.
    const mine = ctx.s3.requests.slice(before).filter((r) => !r.presigned);
    expect(mine.map((r) => r.method)).toEqual(['HEAD', 'GET']);
    expect(mine[1]?.range).toBe('bytes=0-15');
    // The browser's PUT went straight to the store.
    expect(ctx.s3.requests.slice(before).some((r) => r.presigned && r.method === 'PUT')).toBe(true);

    // The merchant sees the document without its key or hash.
    const status = (await owner.client.get('/merchant/v1/kyc')).json().data;
    const shown = status.documents.find((d: { id: string }) => d.id === doc.id);
    expect(shown).toMatchObject({
      type: 'proof_of_address',
      status: 'uploaded',
      mime: 'application/pdf',
    });
    expect(JSON.stringify(shown)).not.toContain(sha256(bytes));
    expect(JSON.stringify(shown)).not.toContain('kyc/');
  });

  it('accepts exactly PDF, JPEG and PNG up to 10 MB, at presign time', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'presign');
    const ok = declare('other', FILES.pdf(), 'application/pdf');
    expect((await owner.client.post('/merchant/v1/kyc/documents/presign', ok)).statusCode).toBe(
      200
    );
    const exactly = { ...ok, sizeBytes: 10 * 1024 * 1024 };
    expect(
      (await owner.client.post('/merchant/v1/kyc/documents/presign', exactly)).statusCode
    ).toBe(200);

    const gif = await owner.client.post('/merchant/v1/kyc/documents/presign', {
      ...ok,
      contentType: 'image/gif',
    });
    expect(gif.statusCode).toBe(422);
    expect(gif.json().error.details.reason).toBe('unsupported_file_type');
    const zip = await owner.client.post('/merchant/v1/kyc/documents/presign', {
      ...ok,
      contentType: 'application/zip',
    });
    expect(zip.json().error.details.reason).toBe('unsupported_file_type');
    const big = await owner.client.post('/merchant/v1/kyc/documents/presign', {
      ...ok,
      sizeBytes: 10 * 1024 * 1024 + 1,
    });
    expect(big.statusCode).toBe(400);
    const empty = await owner.client.post('/merchant/v1/kyc/documents/presign', {
      ...ok,
      sizeBytes: 0,
    });
    expect(empty.statusCode).toBe(400);
    const badHash = await owner.client.post('/merchant/v1/kyc/documents/presign', {
      ...ok,
      sha256: 'abc',
    });
    expect(badHash.statusCode).toBe(400);
    const unknownType = await owner.client.post('/merchant/v1/kyc/documents/presign', {
      ...ok,
      type: 'selfie_with_cat',
    });
    expect(unknownType.statusCode).toBe(422);
    expect(unknownType.json().error.details.reason).toBe('unknown_document_type');
  });

  it('signs the type, the exact length and the checksum into the upload', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'signed');
    const bytes = FILES.png();
    const presign = await owner.client.post(
      '/merchant/v1/kyc/documents/presign',
      declare('other', bytes, 'image/png')
    );
    const { upload } = presign.json().data;
    const url = new URL(upload.url);
    expect(url.origin).toBe(ctx.s3.endpoint);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('x-amz-checksum-sha256');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('x-amz-server-side-encryption');
    expect(upload.headers['content-type']).toBe('image/png');
    expect(upload.headers['content-length']).toBe(String(bytes.length));
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(900);
    // Uploading different bytes than were declared is refused by the store itself.
    expect(await putToStore(upload, FILES.png(bytes.length - 8))).toBe(400);
  });

  it('refuses a file whose bytes are not what it is called, and deletes it', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'magic');
    const uuid = await merchantId(owner.merchantId);
    const existing = (await rowsFor(uuid)).map((r) => r.ref);

    // An executable labelled as a PDF.
    const exe = FILES.exe();
    const first = await tryUpload(owner, declare('other', exe, 'application/pdf'), exe);
    expect(first.stored).toBe(200);
    expect(first.confirm.statusCode).toBe(422);
    expect(first.confirm.json().error.details.reason).toBe('unsupported_file_type');
    expect(ctx.s3.objects.has(keyOf(uuid, first.documentId))).toBe(false);

    // A PDF labelled as a PNG.
    const pdf = FILES.pdf();
    const second = await tryUpload(owner, declare('other', pdf, 'image/png'), pdf);
    expect(second.confirm.statusCode).toBe(422);
    expect(second.confirm.json().error.details.reason).toBe('content_type_mismatch');
    expect(ctx.s3.objects.has(keyOf(uuid, second.documentId))).toBe(false);

    // A file with the right bytes under any name is accepted: the name never decides.
    const png = FILES.png();
    const third = await tryUpload(owner, declare('other', png, 'image/png'), png);
    expect(third.confirm.statusCode).toBe(201);
    expect((await rowsFor(uuid)).map((r) => r.ref).sort()).toEqual(
      [...existing, third.documentId].sort()
    );
  });

  it('refuses an object that is missing, the wrong size, or was never uploaded', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'missing');
    const uuid = await merchantId(owner.merchantId);
    const existing = (await rowsFor(uuid)).length;
    const bytes = FILES.pdf();
    const declared = declare('other', bytes, 'application/pdf');

    // Never uploaded.
    const presign = await owner.client.post('/merchant/v1/kyc/documents/presign', declared);
    const nothing = await owner.client.post('/merchant/v1/kyc/documents', {
      ...declared,
      documentId: presign.json().data.documentId,
    });
    expect(nothing.statusCode).toBe(422);
    expect(nothing.json().error.details.reason).toBe('upload_not_found');

    // The store holds something other than what was declared.
    const other = await owner.client.post('/merchant/v1/kyc/documents/presign', declared);
    const id = other.json().data.documentId as string;
    ctx.s3.seed(FAKE_S3.documents, `kyc/${uuid}/${id}`, FILES.pdf(900), 'application/pdf');
    const wrong = await owner.client.post('/merchant/v1/kyc/documents', {
      ...declared,
      documentId: id,
    });
    expect(wrong.json().error.details.reason).toBe('size_mismatch');
    expect(ctx.s3.objects.has(keyOf(uuid, id))).toBe(false);

    // Same size, different content: the checksum the store holds does not match the declaration.
    const third = await owner.client.post('/merchant/v1/kyc/documents/presign', declared);
    const thirdId = third.json().data.documentId as string;
    const swapped = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(bytes.length - 9, 1)]);
    ctx.s3.seed(FAKE_S3.documents, `kyc/${uuid}/${thirdId}`, swapped, 'application/pdf');
    const mismatch = await owner.client.post('/merchant/v1/kyc/documents', {
      ...declared,
      documentId: thirdId,
    });
    expect(mismatch.json().error.details.reason).toBe('checksum_mismatch');
    expect(await rowsFor(uuid)).toHaveLength(existing);
  });

  it('confirms the same upload once, and answers 503 without recording anything when storage is down', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'replay');
    const uuid = await merchantId(owner.merchantId);
    const existing = (await rowsFor(uuid)).length;
    const bytes = FILES.jpeg();
    const declared = declare('other', bytes, 'image/jpeg');
    const { documentId, confirm } = await tryUpload(owner, declared, bytes);
    expect(confirm.statusCode).toBe(201);
    const again = await owner.client.post('/merchant/v1/kyc/documents', {
      ...declared,
      documentId,
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().data.id).toBe(documentId);
    expect(await rowsFor(uuid)).toHaveLength(existing + 1);

    const second = await owner.client.post(
      '/merchant/v1/kyc/documents/presign',
      declare('other', bytes, 'image/jpeg')
    );
    const secondId = second.json().data.documentId;
    await putToStore(second.json().data.upload, bytes);
    ctx.s3.failWith = 503;
    try {
      const down = await owner.client.post('/merchant/v1/kyc/documents', {
        ...declare('other', bytes, 'image/jpeg'),
        documentId: secondId,
      });
      expect(down.statusCode).toBe(503);
    } finally {
      ctx.s3.failWith = null;
    }
    expect(await rowsFor(uuid)).toHaveLength(existing + 1);
    // Once the store is back the same confirmation succeeds.
    const retried = await owner.client.post('/merchant/v1/kyc/documents', {
      ...declare('other', bytes, 'image/jpeg'),
      documentId: secondId,
    });
    expect(retried.statusCode).toBe(201);
  });

  it('keeps merchants apart: another merchant cannot confirm, remove or see a document', async () => {
    const { owner } = await merchantReadyForLevel1(ctx, 'owner-a');
    const doc = await uploadDocument(owner, 'other');
    const thief = await registerMerchantUser(ctx, 'owner-b');
    const bytes = doc.bytes;

    // Confirming another merchant's document id looks in the thief's own key space: nothing there.
    const confirm = await thief.client.post('/merchant/v1/kyc/documents', {
      ...declare('other', bytes, 'application/pdf'),
      documentId: doc.id,
    });
    expect(confirm.statusCode).toBe(422);
    expect(confirm.json().error.details.reason).toBe('upload_not_found');
    expect((await thief.client.delete(`/merchant/v1/kyc/documents/${doc.id}`)).statusCode).toBe(
      404
    );
    expect((await owner.client.delete(`/merchant/v1/kyc/documents/${doc.id}`)).statusCode).toBe(
      200
    );
    expect((await owner.client.delete(`/merchant/v1/kyc/documents/${doc.id}`)).statusCode).toBe(
      404
    );
    expect((await thief.client.get('/merchant/v1/kyc')).json().data.documents).toEqual([]);
  });

  it('does not let a verified document be removed, or documents change during review', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'frozen');
    await submitKyc(owner);
    const during = await owner.client.post(
      '/merchant/v1/kyc/documents/presign',
      declare('other', FILES.pdf(), 'application/pdf')
    );
    expect(during.statusCode).toBe(200); // presigning writes nothing
    const bytes = FILES.pdf();
    const upload = await tryUpload(owner, declare('other', bytes, 'application/pdf'), bytes);
    expect(upload.confirm.statusCode).toBe(409);
    expect(
      (await owner.client.delete(`/merchant/v1/kyc/documents/${identity.id}`)).statusCode
    ).toBe(409);
    const staff = await reviewers(ctx);
    await verifyEverything(staff.maker, owner.merchantId, [identity], []);
    expect(
      (await owner.client.delete(`/merchant/v1/kyc/documents/${identity.id}`)).statusCode
    ).toBe(409);
  });
});

describe('admin access to documents', () => {
  it('issues a short-lived presigned link and writes an audit row naming the document', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'viewing');
    const uuid = await merchantId(owner.merchantId);
    const staff = await staffSession(ctx, 'compliance');

    const none = await sql('select 1 from core.audit_logs where action = $1 and resource_id = $2', [
      'kyc.document.viewed',
      identity.id,
    ]);
    expect(none).toHaveLength(0);

    const res = await staff.client.get(
      `/admin/v1/kyc/${owner.merchantId}/documents/${identity.id}/view`
    );
    expect(res.statusCode).toBe(200);
    const { url, expiresAt, document } = res.json().data;
    expect(document).toMatchObject({ id: identity.id, type: 'national_id' });
    const link = new URL(url);
    expect(link.origin).toBe(ctx.s3.endpoint);
    expect(link.pathname).toBe(`/${FAKE_S3.documents}/kyc/${uuid}/${identity.id}`);
    expect(Number(link.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
    const lifetime = new Date(expiresAt).getTime() - ctx.clock.now().getTime();
    expect(lifetime).toBeLessThanOrEqual(300_000);
    expect(lifetime).toBeGreaterThan(0);

    // The link works against the store, and the store returns the file the merchant uploaded.
    const fetched = await request(url);
    expect(fetched.statusCode).toBe(200);
    expect(Buffer.from(await fetched.body.arrayBuffer()).equals(identity.bytes)).toBe(true);

    const audit = await sql<{
      actor_label: string | null;
      after: Record<string, unknown>;
      merchant_id: string;
    }>(
      `select actor_label, after, merchant_id from core.audit_logs
        where action = 'kyc.document.viewed' and resource_id = $1`,
      [identity.id]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.merchant_id).toBe(uuid);
    expect(audit[0]?.after).toMatchObject({ type: 'national_id', linkTtlSeconds: 300 });
    expect(JSON.stringify(audit[0]?.after)).not.toContain('X-Amz');

    // Every view is its own audit row.
    await staff.client.get(`/admin/v1/kyc/${owner.merchantId}/documents/${identity.id}/view`);
    const twice = await sql(
      'select 1 from core.audit_logs where action = $1 and resource_id = $2',
      ['kyc.document.viewed', identity.id]
    );
    expect(twice).toHaveLength(2);
  });

  it('issues no link when the audit row cannot be written, and none to staff without the permission', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'denied');
    const support = await staffSession(ctx, 'support_agent');
    const denied = await support.client.get(
      `/admin/v1/kyc/${owner.merchantId}/documents/${identity.id}/view`
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('X-Amz-Signature');
    const none = await sql('select 1 from core.audit_logs where action = $1 and resource_id = $2', [
      'kyc.document.viewed',
      identity.id,
    ]);
    expect(none).toHaveLength(0);

    const staff = await staffSession(ctx, 'compliance');
    expect(
      (
        await staff.client.get(
          `/admin/v1/kyc/${owner.merchantId}/documents/kdoc_00000000000000000000000000/view`
        )
      ).statusCode
    ).toBe(404);
    // A document of another merchant is not reachable through this merchant's ref.
    const other = await registerMerchantUser(ctx, 'other-doc');
    expect(
      (await staff.client.get(`/admin/v1/kyc/${other.merchantId}/documents/${identity.id}/view`))
        .statusCode
    ).toBe(404);
  });
});

describe('requirements are data', () => {
  it('lets an administrator change what one country must provide, without a deploy', async () => {
    const staff = await staffSession(ctx, 'compliance');
    const ug = await registerMerchantUser(ctx, 'req-ug');
    const ke = await new Client(ctx.app).post('/merchant/v1/auth/register', {
      email: `ke.${Math.random().toString(16).slice(2)}@example.com`,
      password: 'correct-horse-battery-staple',
      name: 'Kenyan Owner',
      merchant: { legalName: 'Nairobi Traders', country: 'KE', defaultCurrency: 'KES' },
    });
    expect(ke.statusCode).toBe(201);
    const kenyan = new Client(ctx.app);
    const login = await kenyan.post('/merchant/v1/auth/login', {
      email: ke.json().data.user.email,
      password: 'correct-horse-battery-staple',
    });
    kenyan.token = login.json().data.accessToken;

    const codesOf = async (client: Client, level: number) =>
      (
        (await client.get(`/merchant/v1/kyc/requirements?level=${level}`)).json().data
          .requirements as Array<{
          code: string;
        }>
      ).map((r) => r.code);
    expect(await codesOf(ug.client, 2)).toContain('tin_certificate');
    expect(await codesOf(kenyan, 2)).not.toContain('tin_certificate');
    expect(await codesOf(kenyan, 1)).not.toContain('kra_pin');

    const created = await staff.client.post('/admin/v1/kyc/requirements', {
      level: 1,
      country: 'KE',
      code: 'kra_pin',
      kind: 'document',
      evidenceKey: 'kra_pin_certificate',
      label: 'KRA PIN certificate',
      description: 'The PIN certificate issued by the Kenya Revenue Authority.',
    });
    expect(created.statusCode).toBe(201);
    expect(await codesOf(kenyan, 1)).toContain('kra_pin');
    expect(await codesOf(ug.client, 1)).not.toContain('kra_pin');
    // The new document type is now accepted for upload.
    const bytes = FILES.pdf();
    const accepted = await kenyan.post(
      '/merchant/v1/kyc/documents/presign',
      declare('kra_pin_certificate', bytes, 'application/pdf')
    );
    expect(accepted.statusCode).toBe(200);

    const duplicate = await staff.client.post('/admin/v1/kyc/requirements', {
      level: 1,
      country: 'KE',
      code: 'kra_pin',
      kind: 'document',
      evidenceKey: 'kra_pin_certificate',
      label: 'again',
    });
    expect(duplicate.statusCode).toBe(400);
    const nonsense = await staff.client.post('/admin/v1/kyc/requirements', {
      level: 1,
      code: 'odd',
      kind: 'profile_field',
      evidenceKey: 'favourite_colour',
      label: 'odd',
    });
    expect(nonsense.statusCode).toBe(400);

    // A requirement is deactivated, never deleted.
    const gone = await staff.client.delete(`/admin/v1/kyc/requirements/${created.json().data.id}`);
    expect(gone.json().data.active).toBe(false);
    expect(await codesOf(kenyan, 1)).not.toContain('kra_pin');
    const rows = await sql('select 1 from core.kyc_requirements where requirement_code = $1', [
      'kra_pin',
    ]);
    expect(rows).toHaveLength(1);
    const audit = await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 order by seq`,
      [created.json().data.id]
    );
    expect(audit.map((a) => a.action)).toEqual([
      'kyc.requirement.created',
      'kyc.requirement.updated',
    ]);
  });

  it('relaxes a requirement for one business type', async () => {
    const owner = await registerMerchantUser(ctx, 'sole');
    await owner.client.put('/merchant/v1/kyc/profile', { businessType: 'sole_proprietor' });
    const level2 = (await owner.client.get('/merchant/v1/kyc/requirements?level=2')).json().data
      .requirements;
    const cert = level2.find(
      (r: { code: string }) => r.code === 'business_registration_certificate'
    );
    expect(cert.mandatory).toBe(false);
    const company = await registerMerchantUser(ctx, 'company');
    await company.client.put('/merchant/v1/kyc/profile', { businessType: 'limited_company' });
    const asked = (await company.client.get('/merchant/v1/kyc/requirements?level=2')).json().data
      .requirements;
    expect(
      asked.find((r: { code: string }) => r.code === 'business_registration_certificate').mandatory
    ).toBe(true);
  });
});

describe('onboarding screening', () => {
  it('blocks activation on a sanctions match, opens a case and audits it', async () => {
    ctx.sanctions.respond('blocked-trading', [
      {
        id: 'NK-sanctioned-1',
        caption: 'Blocked Trading Company',
        score: 0.97,
        topics: ['sanction'],
      },
    ]);
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'blocked-trading');
    await submitKyc(owner);
    const results = await runScreening(ctx, owner.merchantId);
    expect(results.map((r) => r.status)).toEqual(['confirmed_match']);
    const staff = await reviewers(ctx);
    await verifyEverything(staff.maker, owner.merchantId, [identity]);

    const blocked = await approveKyc(staff.checker, owner.merchantId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('KYC_SCREENING_MATCH');
    const merchant = (
      await sql<{ id: string; status: string; kyc_level: number }>(
        'select id, status, kyc_level from core.merchants where ref = $1',
        [owner.merchantId]
      )
    )[0];
    expect(merchant).toMatchObject({ status: 'pending_kyc', kyc_level: 0 });

    const screening = (
      await staff.checker.client.get(`/admin/v1/aml/screenings?merchant=${owner.merchantId}`)
    ).json().data.items[0];
    expect(screening).toMatchObject({
      status: 'confirmed_match',
      lists: ['sanctions'],
      subjectType: 'merchant',
    });
    expect(screening.hits[0]).toMatchObject({ entityId: 'NK-sanctioned-1', score: 0.97 });
    expect(screening.case).toMatch(/^case_/);

    const cases = await sql<{ source: string; severity: string; status: string }>(
      'select source, severity, status from core.aml_cases where merchant_id = $1',
      [merchant?.id]
    );
    expect(cases).toEqual([{ source: 'screening', severity: 'critical', status: 'open' }]);
    const audit = await sql<{ action: string; actor_type: string }>(
      `select action, actor_type from core.audit_logs where merchant_id = $1 and action like 'aml.%' order by seq`,
      [merchant?.id]
    );
    expect(audit.map((a) => a.action)).toEqual(['aml.screening.completed', 'aml.case.opened']);
    // The name that was screened is not kept; the provider got it.
    const stored = await sql('select result::text as r from core.aml_screenings where ref = $1', [
      screening.id,
    ]);
    expect(JSON.stringify(stored)).not.toContain('blocked-trading Ltd');
    expect(ctx.sanctions.received).toContain('blocked-trading Ltd');
  });

  it('treats a PEP match the same way, and an analyst can confirm a possible match', async () => {
    ctx.sanctions.respond('Polly Politician', [
      { id: 'NK-pep-7', caption: 'Polly Politician', score: 0.95, topics: ['role.pep'] },
    ]);
    ctx.sanctions.respond('Maybe Person', [
      { id: 'NK-maybe', caption: 'Maybe Persson', score: 0.75, topics: ['sanction'] },
    ]);
    const owner = await registerMerchantUser(ctx, 'pep-merchant');
    const staff = await staffSession(ctx, 'compliance');
    const pep = await staff.client.post('/admin/v1/aml/screenings', {
      subjectType: 'director',
      subjectId: 'kpty_adhoc',
      merchant: owner.merchantId,
      entityType: 'person',
      name: 'Polly Politician',
      country: 'UG',
    });
    expect(pep.statusCode).toBe(201);
    expect(pep.json().data).toMatchObject({
      status: 'confirmed_match',
      lists: ['pep'],
      subjectType: 'director',
    });
    expect(pep.json().data.case).toMatch(/^case_/);

    const maybe = await staff.client.post('/admin/v1/aml/screenings', {
      subjectType: 'ubo',
      subjectId: 'kpty_adhoc2',
      merchant: owner.merchantId,
      entityType: 'person',
      name: 'Maybe Person',
    });
    expect(maybe.json().data.status).toBe('potential_match');
    expect(maybe.json().data.case).toBeNull();
    const confirmed = await staff.client.post(
      `/admin/v1/aml/screenings/${maybe.json().data.id}/decide`,
      {
        decision: 'confirm',
        note: 'Same date of birth and country.',
      }
    );
    expect(confirmed.json().data.status).toBe('confirmed_match');
    expect(confirmed.json().data.case).toMatch(/^case_/);
    // A decision is final.
    const again = await staff.client.post(
      `/admin/v1/aml/screenings/${maybe.json().data.id}/decide`,
      {
        decision: 'clear',
        note: 'Changed my mind.',
      }
    );
    expect(again.statusCode).toBe(409);
    const clear = await staff.client.post('/admin/v1/aml/screenings', {
      subjectType: 'customer',
      subjectId: 'cus_1',
      entityType: 'person',
      name: 'Nobody Special',
    });
    expect(clear.json().data).toMatchObject({ status: 'clear', hits: [], case: null });
  });

  it('blocks rather than clears when the provider does not answer, and is idempotent when it does', async () => {
    const { owner, identity } = await merchantReadyForLevel1(ctx, 'outage');
    await submitKyc(owner);
    ctx.sanctions.failWith = 503;
    try {
      expect(await errorCodeOf(runScreening(ctx, owner.merchantId))).toBe(
        ScreeningUnavailableError.name
      );
    } finally {
      ctx.sanctions.failWith = null;
    }
    const uuid = await merchantId(owner.merchantId);
    expect(
      await sql('select 1 from core.aml_screenings where merchant_id = $1', [uuid])
    ).toHaveLength(0);

    const staff = await reviewers(ctx);
    await verifyEverything(staff.maker, owner.merchantId, [identity]);
    const refused = await approveKyc(staff.checker, owner.merchantId);
    expect(refused.json().error.code).toBe('KYC_SCREENING_REQUIRED');

    await runScreening(ctx, owner.merchantId);
    const calls = ctx.sanctions.calls.count;
    await runScreening(ctx, owner.merchantId);
    await runScreening(ctx, owner.merchantId);
    expect(ctx.sanctions.calls.count).toBe(calls);
    expect(
      await sql('select 1 from core.aml_screenings where merchant_id = $1', [uuid])
    ).toHaveLength(1);
    expect((await approveKyc(staff.checker, owner.merchantId)).statusCode).toBe(200);
  });

  it('treats an unconfigured provider as no answer', async () => {
    const owner = await registerMerchantUser(ctx, 'unconfigured');
    const [merchant] = await sql<{ id: string }>('select id from core.merchants where ref = $1', [
      owner.merchantId,
    ]);
    const none = new OpenSanctionsScreening({
      SANCTIONS_PROVIDER: undefined,
      SANCTIONS_API_KEY: undefined,
      SANCTIONS_BASE_URL: undefined,
      SANCTIONS_TIMEOUT_MS: 1000,
      SANCTIONS_LISTS: ['UN'],
    });
    expect(none.configured).toBe(false);
    await expect(none.screen({ entityType: 'person', name: 'X Y' })).rejects.toBeInstanceOf(
      ScreeningUnavailableError
    );
    expect(merchant).toBeTruthy();
  });
});
