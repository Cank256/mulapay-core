/**
 * Team management, API keys and the `/v1` key authentication path, including role
 * permissions, ownership invariants, cross-merchant isolation (spec 8.4) and the closed
 * merchant rule (spec 6.10).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  activateMerchantDirectly,
  addTeamMember,
  Client,
  loginMerchantUser,
  PASSWORD,
  registerMerchantUser,
  staffSession,
  startContext,
  uniqueEmail,
  type MerchantUser,
  type StaffSession,
  type TestContext,
} from '../support/identity';

let ctx: TestContext;
let owner: MerchantUser;
let rival: MerchantUser;

beforeAll(async () => {
  ctx = await startContext();
  owner = await registerMerchantUser(ctx, 'owner');
  rival = await registerMerchantUser(ctx, 'rival');
});

afterAll(async () => {
  await ctx.close();
});

describe('team', () => {
  it('invites, accepts and lists members; the token works once', async () => {
    const email = uniqueEmail('dev');
    const invite = await owner.client.post('/dashboard/v1/team/invites', {
      email,
      role: 'developer',
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().data).toMatchObject({
      email,
      role: 'developer',
      expired: false,
      token: expect.any(String),
    });
    const pending = await owner.client.get('/dashboard/v1/team/invites');
    expect(pending.json().data[0]).not.toHaveProperty('token');
    expect(
      (await owner.client.post('/dashboard/v1/team/invites', { email, role: 'viewer' })).json()
        .error.code
    ).toBe('INVITATION_ALREADY_PENDING');

    const member = new Client(ctx.app);
    const body = { token: invite.json().data.token, name: 'Dev', password: PASSWORD };
    expect((await member.post('/dashboard/v1/auth/accept-invite', body)).statusCode).toBe(200);
    expect((await member.post('/dashboard/v1/auth/accept-invite', body)).json().error.code).toBe(
      'INVITATION_INVALID'
    );
    const team = await owner.client.get('/dashboard/v1/team');
    expect(
      team
        .json()
        .data.map((m: { role: string }) => m.role)
        .sort()
    ).toEqual(['developer', 'owner']);
  });

  it('requires the existing password to accept into a second merchant, and binds login by merchant', async () => {
    const invite = await rival.client.post('/dashboard/v1/team/invites', {
      email: owner.email,
      role: 'viewer',
    });
    const token = invite.json().data.token;
    const wrong = await new Client(ctx.app).post('/dashboard/v1/auth/accept-invite', {
      token,
      password: 'not-the-password',
    });
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const ok = await new Client(ctx.app).post('/dashboard/v1/auth/accept-invite', {
      token,
      password: PASSWORD,
    });
    expect(ok.json().data).toMatchObject({ merchantId: rival.merchantId, role: 'viewer' });

    const client = new Client(ctx.app);
    const asViewer = await loginMerchantUser(client, owner.email, rival.merchantId);
    expect(asViewer.merchant).toEqual({ id: rival.merchantId, role: 'viewer' });
    const defaultLogin = await loginMerchantUser(new Client(ctx.app), owner.email);
    expect(defaultLogin.merchant.id).toBe(owner.merchantId);
    expect(
      (await client.post('/dashboard/v1/team/invites', { email: uniqueEmail(), role: 'viewer' }))
        .statusCode
    ).toBe(403);
    await rival.client.delete(`/dashboard/v1/team/${owner.userId}`);
  });

  it('enforces role permissions: a viewer reads but cannot manage, and denials are audited', async () => {
    const viewer = await addTeamMember(ctx, owner, 'viewer');
    expect((await viewer.client.get('/dashboard/v1/team')).statusCode).toBe(200);
    expect((await viewer.client.get('/dashboard/v1/merchant')).statusCode).toBe(200);
    const denied = await viewer.client.post('/dashboard/v1/team/invites', {
      email: uniqueEmail(),
      role: 'viewer',
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (await viewer.client.patch('/dashboard/v1/merchant', { tradingName: 'X' })).statusCode
    ).toBe(403);
    expect((await viewer.client.get('/dashboard/v1/api-keys')).statusCode).toBe(403);
  });

  it('applies role changes and removals on the member’s next request', async () => {
    const member = await addTeamMember(ctx, owner, 'viewer');
    expect((await member.client.get('/dashboard/v1/api-keys')).statusCode).toBe(403);
    const changed = await owner.client.patch(`/dashboard/v1/team/${member.userId}`, {
      role: 'developer',
    });
    expect(changed.json().data.role).toBe('developer');
    expect((await member.client.get('/dashboard/v1/api-keys')).statusCode).toBe(200);
    expect((await owner.client.delete(`/dashboard/v1/team/${member.userId}`)).statusCode).toBe(200);
    expect((await member.client.get('/dashboard/v1/merchant')).statusCode).toBe(401);
    expect(
      await loginMerchantUser(member.client, member.email).catch((e: Error) => e.message)
    ).toMatch(/login failed/);
  });

  it('protects the owner and lets only the owner transfer ownership', async () => {
    const admin = await addTeamMember(ctx, owner, 'admin');
    expect(
      (await admin.client.delete(`/dashboard/v1/team/${owner.userId}`)).json().error.code
    ).toBe('OWNER_PROTECTED');
    expect(
      (await admin.client.patch(`/dashboard/v1/team/${owner.userId}`, { role: 'viewer' })).json()
        .error.code
    ).toBe('OWNER_PROTECTED');
    expect(
      (await admin.client.patch(`/dashboard/v1/team/${admin.userId}`, { role: 'owner' })).json()
        .error.code
    ).toBe('OWNER_PROTECTED');
    expect(
      (await owner.client.patch(`/dashboard/v1/team/${owner.userId}`, { role: 'owner' })).json()
        .error.code
    ).toBe('OWNER_PROTECTED');

    const transfer = await owner.client.patch(`/dashboard/v1/team/${admin.userId}`, {
      role: 'owner',
    });
    expect(transfer.json().data.role).toBe('owner');
    const team = (await admin.client.get('/dashboard/v1/team')).json().data as Array<{
      userId: string;
      role: string;
    }>;
    expect(team.filter((m) => m.role === 'owner').map((m) => m.userId)).toEqual([admin.userId]);
    expect(team.find((m) => m.userId === owner.userId)?.role).toBe('admin');
    // Hand it back for the remaining tests.
    await admin.client.patch(`/dashboard/v1/team/${owner.userId}`, { role: 'owner' });
  });
});

describe('merchant profile and invitations', () => {
  it('lets the owner edit public details, audited with before and after', async () => {
    const res = await owner.client.patch('/dashboard/v1/merchant', {
      tradingName: 'Owner Trading',
      website: 'https://owner.example.com',
      supportEmail: 'Support@Example.com',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      tradingName: 'Owner Trading',
      supportEmail: 'support@example.com',
    });
    // Legal identity is admin-only.
    expect(
      (await owner.client.patch('/dashboard/v1/merchant', { legalName: 'New' })).statusCode
    ).toBe(400);
    const unchanged = await owner.client.patch('/dashboard/v1/merchant', {});
    expect(unchanged.json().data.tradingName).toBe('Owner Trading');
  });

  it('revokes a pending invitation so its token no longer works', async () => {
    const invite = await owner.client.post('/dashboard/v1/team/invites', {
      email: uniqueEmail(),
      role: 'viewer',
    });
    const { id, token } = invite.json().data;
    expect((await owner.client.delete(`/dashboard/v1/team/invites/${id}`)).statusCode).toBe(200);
    expect((await owner.client.delete(`/dashboard/v1/team/invites/${id}`)).statusCode).toBe(404);
    const accept = await new Client(ctx.app).post('/dashboard/v1/auth/accept-invite', {
      token,
      name: 'x',
      password: PASSWORD,
    });
    expect(accept.json().error.code).toBe('INVITATION_INVALID');
  });

  it('expires invitations after 7 days and allows a fresh one', async () => {
    const email = uniqueEmail('late');
    const first = (
      await owner.client.post('/dashboard/v1/team/invites', { email, role: 'viewer' })
    ).json().data;
    ctx.clock.advanceBy(7 * 86_400_000 + 1000);
    await loginMerchantUser(owner.client, owner.email);
    const listed = (await owner.client.get('/dashboard/v1/team/invites'))
      .json()
      .data.find((i: { id: string }) => i.id === first.id);
    expect(listed.expired).toBe(true);
    const late = await new Client(ctx.app).post('/dashboard/v1/auth/accept-invite', {
      token: first.token,
      name: 'x',
      password: PASSWORD,
    });
    expect(late.json().error.code).toBe('INVITATION_INVALID');
    const second = await owner.client.post('/dashboard/v1/team/invites', { email, role: 'viewer' });
    expect(second.statusCode).toBe(201);
    const accepted = await new Client(ctx.app).post('/dashboard/v1/auth/accept-invite', {
      token: second.json().data.token,
      name: 'Late',
      password: PASSWORD,
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('re-adds a removed member through a new invitation, and refuses inviting an active member', async () => {
    const member = await addTeamMember(ctx, owner, 'support');
    expect(
      (
        await owner.client.post('/dashboard/v1/team/invites', {
          email: member.email,
          role: 'viewer',
        })
      ).json().error.code
    ).toBe('ALREADY_A_MEMBER');
    await owner.client.delete(`/dashboard/v1/team/${member.userId}`);
    const invite = await owner.client.post('/dashboard/v1/team/invites', {
      email: member.email,
      role: 'finance',
    });
    const accepted = await new Client(ctx.app).post('/dashboard/v1/auth/accept-invite', {
      token: invite.json().data.token,
      password: PASSWORD,
    });
    expect(accepted.json().data).toMatchObject({ role: 'finance', userId: member.userId });
    const team = (await owner.client.get('/dashboard/v1/team')).json().data as Array<{
      userId: string;
      role: string;
    }>;
    expect(team.find((m) => m.userId === member.userId)?.role).toBe('finance');
  });

  it('requires a name when the invited email is new', async () => {
    const invite = await owner.client.post('/dashboard/v1/team/invites', {
      email: uniqueEmail(),
      role: 'viewer',
    });
    const res = await new Client(ctx.app).post('/dashboard/v1/auth/accept-invite', {
      token: invite.json().data.token,
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fields[0].path).toBe('name');
  });
});

describe('cross-merchant isolation', () => {
  // Earlier tests move the clock past the access-token lifetime.
  beforeAll(async () => {
    await loginMerchantUser(owner.client, owner.email);
    await loginMerchantUser(rival.client, rival.email);
  });

  it('returns 404 for another merchant’s members, invitations and keys', async () => {
    const invite = await owner.client.post('/dashboard/v1/team/invites', {
      email: uniqueEmail(),
      role: 'viewer',
    });
    const key = await owner.client.post('/dashboard/v1/api-keys', {
      name: 'k',
      environment: 'test',
      scopes: ['payments:read'],
    });
    const keyId = key.json().data.id;
    const attempts = [
      rival.client.delete(`/dashboard/v1/team/invites/${invite.json().data.id}`),
      rival.client.patch(`/dashboard/v1/team/${owner.userId}`, { role: 'viewer' }),
      rival.client.delete(`/dashboard/v1/team/${owner.userId}`),
      rival.client.delete(`/dashboard/v1/api-keys/${keyId}`),
      rival.client.post(`/dashboard/v1/api-keys/${keyId}/roll`, { gracePeriodHours: 0 }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    const rivalKeys = (await rival.client.get('/dashboard/v1/api-keys')).json().data as Array<{
      id: string;
    }>;
    expect(rivalKeys.map((k) => k.id)).not.toContain(keyId);
    const rivalInvites = (await rival.client.get('/dashboard/v1/team/invites')).json()
      .data as Array<{ id: string }>;
    expect(rivalInvites.map((i) => i.id)).not.toContain(invite.json().data.id);
    // The owner's key still works: nothing was changed by the attempts.
    const ping = await new Client(ctx.app).get('/v1/ping', {
      authorization: `Bearer ${key.json().data.key}`,
    });
    expect(ping.statusCode).toBe(200);
  });
});

describe('API keys', () => {
  it('issues a test key once, lists it without its secret, and authenticates /v1/ping', async () => {
    const res = await owner.client.post('/dashboard/v1/api-keys', {
      name: 'server',
      environment: 'test',
      scopes: ['payments:read', 'payments:write'],
    });
    expect(res.statusCode).toBe(201);
    const { key, id, keyPrefix } = res.json().data;
    expect(key).toMatch(/^mp_test_[a-z0-9]{16}_[0-9a-f]{64}$/);
    expect(key.startsWith(keyPrefix)).toBe(true);
    const listed = JSON.stringify((await owner.client.get('/dashboard/v1/api-keys')).json().data);
    expect(listed).toContain(id);
    expect(listed).not.toContain(key.split('_')[3]);
    expect(listed).not.toMatch(/secretHash|secret_hash/);

    const ping = await new Client(ctx.app).get('/v1/ping', { authorization: `Bearer ${key}` });
    expect(ping.json().data).toEqual({
      ok: true,
      merchantId: owner.merchantId,
      environment: 'test',
      apiKeyId: id,
    });
  });

  it('refuses wrong secrets, unknown keys, other environments and other auth types on /v1', async () => {
    const { key } = (
      await owner.client.post('/dashboard/v1/api-keys', {
        name: 'a',
        environment: 'test',
        scopes: ['payments:read'],
      })
    ).json().data;
    const client = new Client(ctx.app);
    const wrongSecret = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0');
    for (const token of [
      wrongSecret,
      key.replace('mp_test_', 'mp_live_'),
      'mp_test_aaaaaaaaaaaaaaaa_' + '0'.repeat(64),
      owner.client.token ?? '',
    ]) {
      expect((await client.get('/v1/ping', { authorization: `Bearer ${token}` })).statusCode).toBe(
        401
      );
    }
    // An API key is not accepted on the dashboard.
    expect(
      (await client.get('/dashboard/v1/merchant', { authorization: `Bearer ${key}` })).statusCode
    ).toBe(401);
  });

  it('needs an active merchant for live keys', async () => {
    const live = { name: 'live', environment: 'live', scopes: ['payments:read'] };
    expect((await owner.client.post('/dashboard/v1/api-keys', live)).json().error.code).toBe(
      'MERCHANT_NOT_ACTIVE'
    );
    const fresh = await registerMerchantUser(ctx, 'active');
    await activateMerchantDirectly(inject('databaseUrls').superuser, fresh.merchantId);
    const created = await fresh.client.post('/dashboard/v1/api-keys', live);
    expect(created.json().data.key).toMatch(/^mp_live_/);
  });

  it('revokes immediately and refuses a second revoke', async () => {
    const { key, id } = (
      await owner.client.post('/dashboard/v1/api-keys', {
        name: 'r',
        environment: 'test',
        scopes: ['payments:read'],
      })
    ).json().data;
    expect((await owner.client.delete(`/dashboard/v1/api-keys/${id}`)).statusCode).toBe(200);
    expect(
      (await new Client(ctx.app).get('/v1/ping', { authorization: `Bearer ${key}` })).statusCode
    ).toBe(401);
    expect((await owner.client.delete(`/dashboard/v1/api-keys/${id}`)).json().error.code).toBe(
      'API_KEY_REVOKED'
    );
    const listed = (await owner.client.get('/dashboard/v1/api-keys'))
      .json()
      .data.find((k: { id: string }) => k.id === id);
    expect(listed.status).toBe('revoked');
  });

  it('rolls a key with a grace period, once', async () => {
    const original = (
      await owner.client.post('/dashboard/v1/api-keys', {
        name: 'roll',
        environment: 'test',
        scopes: ['balances:read'],
      })
    ).json().data;
    const rolled = await owner.client.post(`/dashboard/v1/api-keys/${original.id}/roll`, {
      gracePeriodHours: 1,
    });
    expect(rolled.statusCode).toBe(201);
    expect(rolled.json().data).toMatchObject({ name: 'roll', scopes: ['balances:read'] });
    const auth = (k: string) =>
      new Client(ctx.app).get('/v1/ping', { authorization: `Bearer ${k}` });
    expect((await auth(original.key)).statusCode).toBe(200);
    expect((await auth(rolled.json().data.key)).statusCode).toBe(200);
    expect(
      (
        await owner.client.post(`/dashboard/v1/api-keys/${original.id}/roll`, {
          gracePeriodHours: 0,
        })
      ).json().error.code
    ).toBe('API_KEY_REVOKED');
    ctx.clock.advanceBy(3_600_001);
    expect((await auth(original.key)).statusCode).toBe(401);
    expect((await auth(rolled.json().data.key)).statusCode).toBe(200);
    await loginMerchantUser(owner.client, owner.email);

    const immediate = (
      await owner.client.post('/dashboard/v1/api-keys', {
        name: 'now',
        environment: 'test',
        scopes: ['balances:read'],
      })
    ).json().data;
    await owner.client.post(`/dashboard/v1/api-keys/${immediate.id}/roll`, { gracePeriodHours: 0 });
    expect((await auth(immediate.key)).statusCode).toBe(401);
  });

  it('enforces the IP allowlist and validates entries', async () => {
    const created = await owner.client.post('/dashboard/v1/api-keys', {
      name: 'ip',
      environment: 'test',
      scopes: ['payments:read'],
      ipAllowlist: ['192.0.2.0/24'],
    });
    const key = created.json().data.key;
    const ping = (ip: string) =>
      ctx.app.inject({
        method: 'GET',
        url: '/v1/ping',
        remoteAddress: ip,
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await ping('192.0.2.10')).statusCode).toBe(200);
    expect((await ping('198.51.100.1')).statusCode).toBe(401);
    const bad = await owner.client.post('/dashboard/v1/api-keys', {
      name: 'bad',
      environment: 'test',
      scopes: ['payments:read'],
      ipAllowlist: ['10.0.0.1/8'],
    });
    expect(bad.statusCode).toBe(400);
  });

  it('validates scopes and expiry', async () => {
    const base = { name: 'v', environment: 'test' };
    expect(
      (await owner.client.post('/dashboard/v1/api-keys', { ...base, scopes: [] })).statusCode
    ).toBe(400);
    expect(
      (await owner.client.post('/dashboard/v1/api-keys', { ...base, scopes: ['admin:all'] }))
        .statusCode
    ).toBe(400);
    const past = await owner.client.post('/dashboard/v1/api-keys', {
      ...base,
      scopes: ['payments:read'],
      expiresAt: '2000-01-01T00:00:00Z',
    });
    expect(past.statusCode).toBe(400);
  });
});

describe('closed merchant', () => {
  let staff: StaffSession;
  let member: MerchantUser;

  beforeAll(async () => {
    staff = await staffSession(ctx);
    member = await registerMerchantUser(ctx, 'closing');
  });

  it('keeps reads and blocks every write once closed', async () => {
    const { key } = (
      await member.client.post('/dashboard/v1/api-keys', {
        name: 'k',
        environment: 'test',
        scopes: ['payments:read'],
      })
    ).json().data;
    const closed = await staff.client.post(`/admin/v1/merchants/${member.merchantId}/close`, {
      reason: 'test',
    });
    expect(closed.json().data.status).toBe('closed');

    expect((await member.client.get('/dashboard/v1/merchant')).json().data.status).toBe('closed');
    expect((await member.client.get('/dashboard/v1/team')).statusCode).toBe(200);
    for (const res of [
      await member.client.patch('/dashboard/v1/merchant', { tradingName: 'x' }),
      await member.client.post('/dashboard/v1/team/invites', {
        email: uniqueEmail(),
        role: 'viewer',
      }),
      await member.client.post('/dashboard/v1/api-keys', {
        name: 'k2',
        environment: 'test',
        scopes: ['payments:read'],
      }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('MERCHANT_CLOSED');
    }
    expect(
      (await new Client(ctx.app).get('/v1/ping', { authorization: `Bearer ${key}` })).statusCode
    ).toBe(200);
    expect((await member.client.post('/dashboard/v1/auth/logout')).statusCode).toBe(200);
  });
});
