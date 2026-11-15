/**
 * Admin surface end to end (Phase 1 exit criteria): a bootstrapped admin logs in with
 * MFA, creates a merchant, invites its owner, runs lifecycle actions with step-up, edits
 * roles, and every action is audited and the chain verifies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  activateMerchantDirectly,
  bootstrapStaff,
  Client,
  loginMerchantUser,
  loginStaff,
  nextTotp,
  PASSWORD,
  registerMerchantUser,
  staffSession,
  startContext,
  uniqueEmail,
  type StaffSession,
  type TestContext,
} from '../support/identity';
import { testConfig } from '../support/test-env';

let ctx: TestContext;
let admin: StaffSession;

beforeAll(async () => {
  ctx = await startContext();
  admin = await staffSession(ctx);
});

afterAll(async () => {
  await ctx.close();
});

async function auditRows(filter: Record<string, string>) {
  const query = new URLSearchParams({ limit: '200', ...filter }).toString();
  const res = await admin.client.get(`/admin/v1/audit-logs?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json().data.items as Array<Record<string, unknown>>;
}

describe('admin bootstrap and login', () => {
  it('refuses a second bootstrap for the same email', async () => {
    await expect(bootstrapStaff(ctx, 'super_admin', admin.admin.email)).rejects.toThrow(
      /already exists/
    );
  });

  it('always requires MFA: the password step returns a challenge, never tokens', async () => {
    const client = new Client(ctx.app);
    const res = await client.post('/admin/v1/auth/login', {
      email: admin.admin.email,
      password: admin.admin.password,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      status: 'mfa_required',
      mfaToken: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a wrong TOTP code and a replayed one', async () => {
    const client = new Client(ctx.app);
    const login = await client.post('/admin/v1/auth/login', {
      email: admin.admin.email,
      password: admin.admin.password,
    });
    const mfaToken = login.json().data.mfaToken;
    const wrong = await client.post('/admin/v1/auth/mfa/verify', { mfaToken, code: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_MFA_CODE');
    const code = nextTotp(ctx.clock, admin.admin.totpSecret);
    const ok = await client.post('/admin/v1/auth/mfa/verify', { mfaToken, code });
    expect(ok.statusCode).toBe(200);
    const again = await client.post('/admin/v1/auth/login', {
      email: admin.admin.email,
      password: admin.admin.password,
    });
    const replay = await client.post('/admin/v1/auth/mfa/verify', {
      mfaToken: again.json().data.mfaToken,
      code,
    });
    expect(replay.json().error.code).toBe('INVALID_MFA_CODE');
  });

  it('rotates the admin refresh cookie behind CSRF and keeps MFA on the new token', async () => {
    const session = await staffSession(ctx);
    const res = await session.client.post('/admin/v1/auth/refresh', undefined, {
      'x-csrf-token': session.client.cookies.mp_csrf ?? '',
    });
    expect(res.statusCode).toBe(200);
    session.client.token = res.json().data.accessToken;
    expect((await session.client.get('/admin/v1/auth/me')).json().data.session.mfa).toBe(true);
    // A dashboard refresh cookie is not accepted by the admin surface.
    const owner = await registerMerchantUser(ctx);
    const cross = await owner.client.post('/admin/v1/auth/refresh', undefined, {
      'x-csrf-token': owner.client.cookies.mp_csrf ?? '',
    });
    expect(cross.json().error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('refuses to bootstrap without a data encryption key', async () => {
    const noKey = { ...ctx, config: testConfig({ DATA_ENCRYPTION_KEY: '' }) };
    await expect(bootstrapStaff(noKey)).rejects.toThrow(/DATA_ENCRYPTION_KEY/);
  });

  it('exposes me with roles and an MFA session', async () => {
    const res = await admin.client.get('/admin/v1/auth/me');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      roles: ['super_admin'],
      session: { mfa: true, amr: ['pwd', 'otp'] },
    });
  });

  it('refuses dashboard tokens, merchant users and anonymous callers on admin routes', async () => {
    const owner = await registerMerchantUser(ctx);
    const asMerchant = await owner.client.get('/admin/v1/merchants');
    expect(asMerchant.statusCode).toBe(401);
    const login = await new Client(ctx.app).post('/admin/v1/auth/login', {
      email: owner.email,
      password: PASSWORD,
    });
    expect(login.json().error.code).toBe('INVALID_CREDENTIALS');
    expect((await new Client(ctx.app).get('/admin/v1/merchants')).statusCode).toBe(401);
  });

  it('refuses an admin token on the dashboard', async () => {
    expect((await admin.client.get('/dashboard/v1/auth/me')).statusCode).toBe(401);
  });
});

describe('merchants', () => {
  it('creates a draft merchant with an owner invitation the owner can accept, all audited', async () => {
    const ownerEmail = uniqueEmail('owner');
    const res = await admin.client.post('/admin/v1/merchants', {
      legalName: 'Acme Uganda Ltd',
      country: 'UG',
      defaultCurrency: 'UGX',
      ownerEmail,
    });
    expect(res.statusCode).toBe(201);
    const { merchant, ownerInvitation } = res.json().data;
    expect(merchant).toMatchObject({ status: 'draft', kycLevel: 0, legalName: 'Acme Uganda Ltd' });
    expect(merchant.id).toMatch(/^mch_/);
    expect(JSON.stringify(merchant)).not.toMatch(
      /feePlan|settlementCycle|[0-9a-f]{8}-[0-9a-f]{4}-7/
    );
    expect(ownerInvitation).toMatchObject({
      role: 'owner',
      email: ownerEmail,
      token: expect.any(String),
    });

    const owner = new Client(ctx.app);
    const accepted = await owner.post('/dashboard/v1/auth/accept-invite', {
      token: ownerInvitation.token,
      name: 'Owner',
      password: PASSWORD,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toMatchObject({ merchantId: merchant.id, role: 'owner' });
    await loginMerchantUser(owner, ownerEmail);
    expect((await owner.get('/dashboard/v1/merchant')).json().data.id).toBe(merchant.id);

    const users = await admin.client.get(`/admin/v1/merchants/${merchant.id}/users`);
    expect(users.json().data).toEqual([
      expect.objectContaining({ email: ownerEmail, role: 'owner' }),
    ]);

    const rows = await auditRows({ merchant: merchant.id });
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['merchant.created', 'invitation.created', 'invitation.accepted'])
    );
    const created = rows.find((r) => r.action === 'merchant.created');
    expect(created).toMatchObject({
      actorType: 'user',
      actorId: admin.admin.userId,
      surface: 'admin',
      outcome: 'success',
    });
    expect(created?.after).toMatchObject({ legalName: 'Acme Uganda Ltd', status: 'draft' });
  });

  it('edits a merchant profile with an audited diff', async () => {
    const created = await admin.client.post('/admin/v1/merchants', {
      legalName: 'Before Ltd',
      country: 'UG',
      defaultCurrency: 'UGX',
    });
    const ref = created.json().data.merchant.id;
    const res = await admin.client.patch(`/admin/v1/merchants/${ref}`, {
      legalName: 'After Ltd',
      riskRating: 'high',
      mcc: '5999',
      metadata: { segment: 'retail' },
    });
    expect(res.json().data).toMatchObject({
      legalName: 'After Ltd',
      riskRating: 'high',
      mcc: '5999',
      metadata: { segment: 'retail' },
    });
    const rows = await auditRows({ merchant: ref, action: 'merchant.updated' });
    expect(rows[0]).toMatchObject({
      before: { legalName: 'Before Ltd' },
      after: { legalName: 'After Ltd' },
    });
    expect(rows[0]?.changedFields).toEqual(['legalName', 'mcc', 'metadata', 'riskRating']);
    const tooMuch = await admin.client.patch(`/admin/v1/merchants/${ref}`, {
      metadata: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])),
    });
    expect(tooMuch.statusCode).toBe(400);
  });

  it('validates input and rejects unknown fields and unsupported currencies', async () => {
    const res = await admin.client.post('/admin/v1/merchants', {
      legalName: 'X',
      country: 'Uganda',
      defaultCurrency: 'CHF',
      surprise: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('lists with cursor pagination and rejects a cursor under other filters', async () => {
    for (let i = 0; i < 3; i++) {
      await admin.client.post('/admin/v1/merchants', {
        legalName: `Page ${i}`,
        country: 'KE',
        defaultCurrency: 'KES',
      });
    }
    const first = await admin.client.get('/admin/v1/merchants?limit=2&status=draft');
    expect(first.json().data.items).toHaveLength(2);
    const cursor = first.json().data.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await admin.client.get(
      `/admin/v1/merchants?limit=2&status=draft&cursor=${cursor}`
    );
    expect(second.statusCode).toBe(200);
    const ids = [...first.json().data.items, ...second.json().data.items].map(
      (m: { id: string }) => m.id
    );
    expect(new Set(ids).size).toBe(ids.length);
    const mismatched = await admin.client.get(
      `/admin/v1/merchants?limit=2&status=active&cursor=${cursor}`
    );
    expect(mismatched.json().error.code).toBe('INVALID_CURSOR');
  });

  it('runs the lifecycle with step-up, refusing illegal transitions', async () => {
    const created = await admin.client.post('/admin/v1/merchants', {
      legalName: 'Life',
      country: 'UG',
      defaultCurrency: 'UGX',
    });
    const ref = created.json().data.merchant.id;
    const suspendDraft = await admin.client.post(`/admin/v1/merchants/${ref}/suspend`, {
      reason: 'test',
    });
    expect(suspendDraft.statusCode).toBe(409);
    expect(suspendDraft.json().error).toMatchObject({
      code: 'MERCHANT_INVALID_TRANSITION',
      details: { from: 'draft', to: 'suspended', event: 'suspend' },
    });

    await activateMerchantDirectly(inject('databaseUrls').superuser, ref);
    const suspended = await admin.client.post(`/admin/v1/merchants/${ref}/suspend`, {
      reason: 'risk review',
    });
    expect(suspended.json().data.status).toBe('suspended');
    const activated = await admin.client.post(`/admin/v1/merchants/${ref}/activate`, {
      reason: 'cleared',
    });
    expect(activated.json().data.status).toBe('active');
    expect(
      (await admin.client.post(`/admin/v1/merchants/${ref}/close`, { reason: 'x' })).statusCode
    ).toBe(409);
    await admin.client.post(`/admin/v1/merchants/${ref}/suspend`, { reason: 'closing' });
    const closed = await admin.client.post(`/admin/v1/merchants/${ref}/close`, {
      reason: 'merchant request',
    });
    expect(closed.json().data.status).toBe('closed');
    expect(
      (await admin.client.post(`/admin/v1/merchants/${ref}/activate`, { reason: 'x' })).statusCode
    ).toBe(409);

    const rows = await auditRows({ merchant: ref, action: 'merchant.suspended' });
    expect(rows[0]).toMatchObject({
      before: { status: 'active' },
      after: { status: 'suspended', reason: 'closing' },
    });
  });

  it('requires step-up within 5 minutes for lifecycle actions, and step-up restores it', async () => {
    const session = await staffSession(ctx);
    const created = await session.client.post('/admin/v1/merchants', {
      legalName: 'Step',
      country: 'UG',
      defaultCurrency: 'UGX',
    });
    const ref = created.json().data.merchant.id;
    ctx.clock.advanceBy(6 * 60_000);
    const stale = await session.client.post(`/admin/v1/merchants/${ref}/close`, { reason: 'x' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('STEP_UP_REQUIRED');
    const denied = await auditRows({ resourceId: ref, outcome: 'denied' });
    expect(denied[0]).toMatchObject({ action: 'merchant.closed', actorId: session.admin.userId });

    const badStepUp = await session.client.post('/admin/v1/auth/step-up', {
      password: 'wrong-password',
      code: '000000',
    });
    expect(badStepUp.statusCode).toBe(401);
    const stepUp = await session.client.post('/admin/v1/auth/step-up', {
      password: session.admin.password,
      code: nextTotp(ctx.clock, session.admin.totpSecret),
    });
    expect(stepUp.statusCode).toBe(200);
    session.client.token = stepUp.json().data.accessToken;
    const closed = await session.client.post(`/admin/v1/merchants/${ref}/close`, { reason: 'x' });
    expect(closed.json().data.status).toBe('closed');
  });

  it('enforces staff permissions and audits denied writes', async () => {
    const support = await staffSession(ctx, 'support_agent');
    expect((await support.client.get('/admin/v1/merchants')).statusCode).toBe(200);
    const create = await support.client.post('/admin/v1/merchants', {
      legalName: 'No',
      country: 'UG',
      defaultCurrency: 'UGX',
    });
    expect(create.statusCode).toBe(403);
    expect((await support.client.get('/admin/v1/audit-logs')).statusCode).toBe(403);
    const denied = await auditRows({ action: 'merchant.created', outcome: 'denied' });
    expect(denied.some((r) => r.actorId === support.admin.userId)).toBe(true);
  });

  it('returns 404 for unknown merchants', async () => {
    expect(
      (await admin.client.get('/admin/v1/merchants/mch_01JBX7ZZZZZZZZZZZZZZZZZZZZ')).statusCode
    ).toBe(404);
  });
});

describe('roles', () => {
  // Earlier tests move the shared clock past the step-up window; start a fresh login.
  beforeAll(() => loginStaff(ctx, admin.client, admin.admin));

  it('lists roles and permissions, edits a role, and protects super_admin', async () => {
    const list = await admin.client.get('/admin/v1/roles');
    const viewer = list.json().data.roles.find((r: { key: string }) => r.key === 'viewer');
    expect(viewer.permissions).toEqual([
      'merchant:read',
      'payments:read',
      'team:read',
      'transactions:read',
      'webhooks:read',
    ]);

    const updated = await admin.client.patch('/admin/v1/roles/viewer', {
      permissions: ['merchant:read', 'team:read', 'api_keys:read'],
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.permissions).toEqual([
      'api_keys:read',
      'merchant:read',
      'team:read',
    ]);
    const rows = await auditRows({ action: 'role.permissions_updated', resourceId: 'viewer' });
    expect(rows[0]).toMatchObject({
      before: {
        permissions: [
          'merchant:read',
          'payments:read',
          'team:read',
          'transactions:read',
          'webhooks:read',
        ],
      },
      changedFields: ['permissions'],
    });
    await admin.client.patch('/admin/v1/roles/viewer', {
      permissions: ['merchant:read', 'team:read'],
    });

    const wrongType = await admin.client.patch('/admin/v1/roles/viewer', {
      permissions: ['merchants:create'],
    });
    expect(wrongType.json().error.code).toBe('ROLE_UPDATE_REJECTED');
    const lockout = await admin.client.patch('/admin/v1/roles/super_admin', {
      permissions: ['merchants:read'],
    });
    expect(lockout.json().error.code).toBe('ROLE_UPDATE_REJECTED');
    expect((await admin.client.patch('/admin/v1/roles/nope', { permissions: [] })).statusCode).toBe(
      404
    );
  });
});

describe('audit log API', () => {
  beforeAll(() => loginStaff(ctx, admin.client, admin.admin));

  it('reads one row, rejects bad windows, and verifies the whole chain', async () => {
    const rows = await auditRows({});
    expect(rows.length).toBeGreaterThan(0);
    const one = await admin.client.get(`/admin/v1/audit-logs/${rows[0]!.seq as number}`);
    expect(one.json().data.hash).toBe(rows[0]!.hash);
    expect((await admin.client.get('/admin/v1/audit-logs/999999999')).statusCode).toBe(404);
    const window = await admin.client.get(
      '/admin/v1/audit-logs?from=2020-01-01T00:00:00Z&to=2025-01-01T00:00:00Z'
    );
    expect(window.statusCode).toBe(400);

    const verify = await admin.client.get('/admin/v1/audit-logs/verify');
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data).toMatchObject({ valid: true, firstBreak: null });
    expect(verify.json().data.checked).toBeGreaterThanOrEqual(rows.length);
  });

  it('logs out: the access token stops working at once', async () => {
    const session = await staffSession(ctx);
    expect((await session.client.post('/admin/v1/auth/logout')).statusCode).toBe(200);
    expect((await session.client.get('/admin/v1/auth/me')).statusCode).toBe(401);
  });
});
