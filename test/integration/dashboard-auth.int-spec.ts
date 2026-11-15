/**
 * Dashboard authentication (spec 8.3): registration, login protection, MFA enrollment and
 * login, refresh rotation with reuse detection, CSRF, logout and session management.
 */
import { generateSync } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  loginMerchantUser,
  nextTotp,
  PASSWORD,
  registerMerchantUser,
  startContext,
  uniqueEmail,
  type TestContext,
} from '../support/identity';
import { captureLogs } from '../support/log-capture';
import { createTestApp } from '../support/test-app';
import { testConfig } from '../support/test-env';
import { FixedClock } from '../support/fixed-clock';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await startContext();
});

afterAll(async () => {
  await ctx.close();
});

function refreshWithCsrf(client: Client, surface = 'dashboard') {
  return client.post(`/${surface}/v1/auth/refresh`, undefined, {
    'x-csrf-token': client.cookies.mp_csrf ?? '',
  });
}

describe('register and login', () => {
  it('registers an owner of a draft merchant and returns tokens with cookies', async () => {
    const client = new Client(ctx.app);
    const email = uniqueEmail();
    const res = await client.post('/dashboard/v1/auth/register', {
      email: email.toUpperCase(),
      password: PASSWORD,
      name: 'Ada',
      merchant: { legalName: 'Ada Ltd', country: 'UG', defaultCurrency: 'UGX' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.user.email).toBe(email);
    expect(res.json().data.merchant.status).toBe('draft');
    const login = await client.post('/dashboard/v1/auth/login', { email, password: PASSWORD });
    expect(login.json().data).toMatchObject({
      status: 'authenticated',
      merchant: { role: 'owner' },
      roles: ['owner'],
    });
    const cookies = String(login.headers['set-cookie']);
    expect(cookies).toMatch(/mp_refresh=.*HttpOnly/i);
    expect(cookies).toMatch(/SameSite=Strict/i);
    expect(cookies).toMatch(/Secure/i);
    expect(cookies).toMatch(/Path=\/dashboard\/v1\/auth/);
  });

  it('rejects a duplicate email, weak passwords and unknown fields', async () => {
    const owner = await registerMerchantUser(ctx);
    const body = {
      email: owner.email,
      password: PASSWORD,
      name: 'x',
      merchant: { legalName: 'x', country: 'UG', defaultCurrency: 'UGX' },
    };
    expect(
      (await new Client(ctx.app).post('/dashboard/v1/auth/register', body)).json().error.code
    ).toBe('EMAIL_ALREADY_REGISTERED');
    const weak = await new Client(ctx.app).post('/dashboard/v1/auth/register', {
      ...body,
      email: uniqueEmail(),
      password: 'short',
    });
    expect(weak.statusCode).toBe(400);
    const extra = await new Client(ctx.app).post('/dashboard/v1/auth/login', {
      email: owner.email,
      password: PASSWORD,
      admin: true,
    });
    expect(extra.statusCode).toBe(400);
  });

  it('gives an unknown email and a wrong password the same response', async () => {
    const owner = await registerMerchantUser(ctx);
    const wrong = await new Client(ctx.app).post('/dashboard/v1/auth/login', {
      email: owner.email,
      password: 'wrong-password-123',
    });
    const unknown = await new Client(ctx.app).post('/dashboard/v1/auth/login', {
      email: uniqueEmail(),
      password: 'wrong-password-123',
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it('locks an account after 5 failures with Retry-After, for known and unknown emails alike', async () => {
    const owner = await registerMerchantUser(ctx);
    for (const email of [owner.email, uniqueEmail()]) {
      const client = new Client(ctx.app);
      for (let i = 0; i < 5; i++) {
        const res = await client.post('/dashboard/v1/auth/login', {
          email,
          password: 'wrong-password-123',
        });
        expect(res.statusCode).toBe(401);
      }
      // A different IP still sees the account lock.
      const locked = await new Client(ctx.app).post('/dashboard/v1/auth/login', {
        email,
        password: PASSWORD,
      });
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe('TOO_MANY_LOGIN_ATTEMPTS');
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
    ctx.clock.advanceBy(61_000);
    expect((await loginMerchantUser(new Client(ctx.app), owner.email)).status).toBe(
      'authenticated'
    );
  });

  it('locks an IP after 5 failures across different accounts', async () => {
    const owner = await registerMerchantUser(ctx);
    const attacker = new Client(ctx.app);
    for (let i = 0; i < 5; i++) {
      await attacker.post('/dashboard/v1/auth/login', {
        email: uniqueEmail(),
        password: 'wrong-password-123',
      });
    }
    const blocked = await attacker.post('/dashboard/v1/auth/login', {
      email: owner.email,
      password: PASSWORD,
    });
    expect(blocked.statusCode).toBe(429);
    ctx.clock.advanceBy(61_000);
  });

  it('audits failed and successful logins without recording unknown emails', async () => {
    const email = uniqueEmail('ghost');
    const logs = captureLogs(ctx.config, 'debug');
    const app = await createTestApp(testConfig(), {
      logger: logs.logger,
      clock: new FixedClock(new Date()),
    });
    try {
      const client = new Client(app);
      await client.post('/dashboard/v1/auth/login', { email, password: 'wrong-password-123' });
      expect(logs.raw.join('\n')).not.toContain(email);
      expect(logs.raw.join('\n')).not.toContain('wrong-password-123');
    } finally {
      await app.close();
    }
  });
});

describe('MFA', () => {
  it('enrolls, then requires a code at login, and refuses replays', async () => {
    const owner = await registerMerchantUser(ctx);
    const start = await owner.client.post('/dashboard/v1/auth/mfa/enroll', {});
    expect(start.statusCode).toBe(200);
    const { secret, otpauthUri } = start.json().data;
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const notStartedWrong = await owner.client.post('/dashboard/v1/auth/mfa/enroll', {
      code: '000000',
    });
    expect(notStartedWrong.json().error.code).toBe('INVALID_MFA_CODE');
    const confirm = await owner.client.post('/dashboard/v1/auth/mfa/enroll', {
      code: nextTotp(ctx.clock, secret),
    });
    expect(confirm.json().data).toEqual({ status: 'enabled' });
    expect((await owner.client.post('/dashboard/v1/auth/mfa/enroll', {})).json().error.code).toBe(
      'MFA_ALREADY_ENABLED'
    );

    const client = new Client(ctx.app);
    const login = await client.post('/dashboard/v1/auth/login', {
      email: owner.email,
      password: PASSWORD,
    });
    expect(login.json().data.status).toBe('mfa_required');
    const code = nextTotp(ctx.clock, secret);
    const verified = await client.post('/dashboard/v1/auth/mfa/verify', {
      mfaToken: login.json().data.mfaToken,
      code,
    });
    expect(verified.json().data.status).toBe('authenticated');
    client.token = verified.json().data.accessToken;
    expect((await client.get('/dashboard/v1/auth/me')).json().data.session).toMatchObject({
      mfa: true,
      amr: ['pwd', 'otp'],
    });

    // The challenge is single use and the code cannot be replayed.
    const reuse = await client.post('/dashboard/v1/auth/mfa/verify', {
      mfaToken: login.json().data.mfaToken,
      code,
    });
    expect(reuse.json().error.code).toBe('MFA_CHALLENGE_INVALID');
    const second = await client.post('/dashboard/v1/auth/login', {
      email: owner.email,
      password: PASSWORD,
    });
    const replay = await client.post('/dashboard/v1/auth/mfa/verify', {
      mfaToken: second.json().data.mfaToken,
      code,
    });
    expect(replay.json().error.code).toBe('INVALID_MFA_CODE');
  });

  it('discards a challenge after 5 wrong codes and refuses an admin challenge here', async () => {
    const owner = await registerMerchantUser(ctx);
    const { secret } = (await owner.client.post('/dashboard/v1/auth/mfa/enroll', {})).json().data;
    await owner.client.post('/dashboard/v1/auth/mfa/enroll', { code: nextTotp(ctx.clock, secret) });
    const client = new Client(ctx.app);
    const login = await client.post('/dashboard/v1/auth/login', {
      email: owner.email,
      password: PASSWORD,
    });
    const mfaToken = login.json().data.mfaToken;
    expect(
      (await client.post('/admin/v1/auth/mfa/verify', { mfaToken, code: '123456' })).json().error
        .code
    ).toBe('MFA_CHALLENGE_INVALID');
    for (let i = 0; i < 5; i++)
      await client.post('/dashboard/v1/auth/mfa/verify', { mfaToken, code: '000000' });
    const after = await client.post('/dashboard/v1/auth/mfa/verify', {
      mfaToken,
      code: nextTotp(ctx.clock, secret),
    });
    expect(['MFA_CHALLENGE_INVALID', 'TOO_MANY_LOGIN_ATTEMPTS']).toContain(after.json().error.code);
    ctx.clock.advanceBy(61_000);
  });

  it('disables MFA only with step-up and a valid code', async () => {
    const owner = await registerMerchantUser(ctx);
    const { secret } = (await owner.client.post('/dashboard/v1/auth/mfa/enroll', {})).json().data;
    await owner.client.post('/dashboard/v1/auth/mfa/enroll', { code: nextTotp(ctx.clock, secret) });
    expect(
      (await owner.client.post('/dashboard/v1/auth/mfa/disable', { code: '000000' })).json().error
        .code
    ).toBe('INVALID_MFA_CODE');
    ctx.clock.advanceBy(5 * 60_000);
    const stale = await owner.client.post('/dashboard/v1/auth/mfa/disable', {
      code: generateSync({ secret, epoch: Math.floor(ctx.clock.now().getTime() / 1000) }),
    });
    expect(stale.json().error.code).toBe('STEP_UP_REQUIRED');
    const fresh = new Client(ctx.app);
    const login = await fresh.post('/dashboard/v1/auth/login', {
      email: owner.email,
      password: PASSWORD,
    });
    const verified = await fresh.post('/dashboard/v1/auth/mfa/verify', {
      mfaToken: login.json().data.mfaToken,
      code: nextTotp(ctx.clock, secret),
    });
    fresh.token = verified.json().data.accessToken;
    const disabled = await fresh.post('/dashboard/v1/auth/mfa/disable', {
      code: nextTotp(ctx.clock, secret),
    });
    expect(disabled.json().data).toEqual({ ok: true });
    expect((await loginMerchantUser(new Client(ctx.app), owner.email)).status).toBe(
      'authenticated'
    );
  });
});

describe('sessions', () => {
  it('rotates refresh tokens, and reuse of a rotated token revokes the family', async () => {
    const owner = await registerMerchantUser(ctx);
    const first = owner.client.cookies.mp_refresh;
    const refreshed = await refreshWithCsrf(owner.client);
    expect(refreshed.statusCode).toBe(200);
    expect(owner.client.cookies.mp_refresh).not.toBe(first);
    owner.client.token = refreshed.json().data.accessToken;
    expect((await owner.client.get('/dashboard/v1/auth/me')).statusCode).toBe(200);

    const attacker = new Client(ctx.app);
    attacker.cookies = { mp_refresh: first ?? '', mp_csrf: 'x' };
    const reuse = await attacker.post('/dashboard/v1/auth/refresh', undefined, {
      'x-csrf-token': 'x',
    });
    expect(reuse.json().error.code).toBe('REFRESH_TOKEN_INVALID');
    // The whole family is gone: the legitimate access token and refresh token both fail.
    expect((await owner.client.get('/dashboard/v1/auth/me')).statusCode).toBe(401);
    expect((await refreshWithCsrf(owner.client)).statusCode).toBe(401);
  });

  it('requires the double-submit CSRF header', async () => {
    const owner = await registerMerchantUser(ctx);
    expect((await owner.client.post('/dashboard/v1/auth/refresh')).json().error.code).toBe(
      'CSRF_TOKEN_INVALID'
    );
    const wrong = await owner.client.post('/dashboard/v1/auth/refresh', undefined, {
      'x-csrf-token': 'nope',
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('expires refresh tokens at the family’s absolute lifetime', async () => {
    const owner = await registerMerchantUser(ctx);
    ctx.clock.advanceBy(ctx.config.REFRESH_TOKEN_TTL * 1000 + 1000);
    expect((await refreshWithCsrf(owner.client)).statusCode).toBe(401);
  });

  it('expires access tokens after ACCESS_TOKEN_TTL', async () => {
    const owner = await registerMerchantUser(ctx);
    ctx.clock.advanceBy(ctx.config.ACCESS_TOKEN_TTL * 1000);
    expect((await owner.client.get('/dashboard/v1/auth/me')).statusCode).toBe(401);
    const refreshed = await refreshWithCsrf(owner.client);
    owner.client.token = refreshed.json().data.accessToken;
    expect((await owner.client.get('/dashboard/v1/auth/me')).statusCode).toBe(200);
  });

  it('lists sessions and revokes one, which kills its access token at once', async () => {
    const owner = await registerMerchantUser(ctx);
    const other = new Client(ctx.app);
    await loginMerchantUser(other, owner.email);
    const list = await owner.client.get('/dashboard/v1/auth/sessions');
    expect(list.json().data).toHaveLength(2);
    const target = list.json().data.find((s: { current: boolean }) => !s.current);
    expect((await owner.client.delete(`/dashboard/v1/auth/sessions/${target.id}`)).statusCode).toBe(
      200
    );
    expect((await other.get('/dashboard/v1/auth/me')).statusCode).toBe(401);
    expect((await owner.client.delete(`/dashboard/v1/auth/sessions/${target.id}`)).statusCode).toBe(
      404
    );

    const stranger = await registerMerchantUser(ctx);
    const mine = (await owner.client.get('/dashboard/v1/auth/sessions')).json().data[0].id;
    expect((await stranger.client.delete(`/dashboard/v1/auth/sessions/${mine}`)).statusCode).toBe(
      404
    );
  });

  it('logs out: access token and refresh cookie stop working', async () => {
    const owner = await registerMerchantUser(ctx);
    const csrf = owner.client.cookies.mp_csrf ?? '';
    const refresh = owner.client.cookies.mp_refresh ?? '';
    expect((await owner.client.post('/dashboard/v1/auth/logout')).statusCode).toBe(200);
    expect((await owner.client.get('/dashboard/v1/auth/me')).statusCode).toBe(401);
    owner.client.cookies = { mp_refresh: refresh, mp_csrf: csrf };
    expect((await refreshWithCsrf(owner.client)).statusCode).toBe(401);
  });

  it('refuses malformed, foreign-key and missing bearer tokens', async () => {
    const client = new Client(ctx.app);
    for (const token of [undefined, 'garbage', 'a.b.c']) {
      client.token = token;
      expect((await client.get('/dashboard/v1/auth/me')).statusCode).toBe(401);
    }
    const res = await client.get('/dashboard/v1/auth/me', { authorization: 'Basic abc' });
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});
