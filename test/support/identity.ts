/**
 * Integration fixtures for Phase 1: an HTTP client per actor, staff bootstrap, merchant
 * users with or without MFA, and TOTP codes on the shared FixedClock.
 *
 * Every client gets its own random client IP so login lockout counters (which are per IP)
 * never leak between tests or test files running in parallel.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { generateSync } from 'otplib';
import pino from 'pino';
import type { InjectOptions, Response } from 'light-my-request';
import { AdminBootstrapModule } from '../../src/modules/auth/admin-bootstrap.module';
import {
  AdminBootstrapService,
  type BootstrappedAdmin,
} from '../../src/modules/auth/admin-bootstrap.service';
import type { StaffRole } from '../../src/common/authz/permissions';
import type { AppConfig } from '../../src/config/configuration';
import { FixedClock } from './fixed-clock';
import { createTestApp } from './test-app';
import { testConfig } from './test-env';

export function uniqueEmail(label = 'user'): string {
  return `${label}.${randomBytes(6).toString('hex')}@example.com`;
}

export function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

export const PASSWORD = 'CorrectHorseBattery99@';

export interface TestContext {
  readonly app: NestFastifyApplication;
  readonly clock: FixedClock;
  readonly config: AppConfig;
  close(): Promise<void>;
}

/** The API app on a FixedClock starting now. */
export async function startContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const clock = new FixedClock(new Date());
  const config = testConfig(overrides);
  // TEST_LOGS=1 prints error-level logs, for debugging a failing suite.
  const logger = pino({ level: process.env.TEST_LOGS ? 'error' : 'silent' });
  const app = await createTestApp(config, { clock, logger });
  return { app, clock, config, close: () => app.close() };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** An HTTP client with a fixed client IP and an optional bearer token. */
export class Client {
  token?: string;
  cookies: Record<string, string> = {};
  readonly ip = randomIp();

  constructor(private readonly app: NestFastifyApplication) {}

  async request(
    method: Method,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const options: InjectOptions = {
      method,
      url,
      remoteAddress: this.ip,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      cookies: this.cookies,
      ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}),
    };
    const res = await this.app.inject(options);
    for (const cookie of res.cookies as Array<{ name: string; value: string }>) {
      if (cookie.value === '') delete this.cookies[cookie.name];
      else this.cookies[cookie.name] = cookie.value;
    }
    return res;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request('GET', url, undefined, headers);
  }
  post(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request('POST', url, body ?? {}, headers);
  }
  patch(url: string, body: unknown) {
    return this.request('PATCH', url, body);
  }
  put(url: string, body: unknown) {
    return this.request('PUT', url, body);
  }
  delete(url: string, body?: unknown) {
    return this.request('DELETE', url, body);
  }
}

/** A TOTP code for `secret`, one step after the last code taken (codes are single-use). */
export function nextTotp(clock: FixedClock, secret: string): string {
  clock.advanceBy(30_000);
  return generateSync({ secret, epoch: Math.floor(clock.now().getTime() / 1000) });
}

export async function bootstrapStaff(
  ctx: TestContext,
  role: StaffRole = 'super_admin',
  email = uniqueEmail(role)
): Promise<BootstrappedAdmin> {
  const context = await NestFactory.createApplicationContext(
    AdminBootstrapModule.forRoot(ctx.config, pino({ level: 'silent' }), ctx.clock),
    { logger: false }
  );
  try {
    return await context
      .get(AdminBootstrapService)
      .bootstrap({ email, name: `Staff ${role}`, role });
  } finally {
    await context.close();
  }
}

export interface StaffSession {
  readonly client: Client;
  readonly admin: BootstrappedAdmin;
}

/** Bootstraps a staff user and logs them in through password + TOTP. */
export async function staffSession(
  ctx: TestContext,
  role: StaffRole = 'super_admin'
): Promise<StaffSession> {
  const admin = await bootstrapStaff(ctx, role);
  const client = new Client(ctx.app);
  await loginStaff(ctx, client, admin);
  return { client, admin };
}

export async function loginStaff(ctx: TestContext, client: Client, admin: BootstrappedAdmin) {
  const login = await client.post('/admin/v1/auth/login', {
    email: admin.email,
    password: admin.password,
  });
  if (login.statusCode !== 200) throw new Error(`staff login failed: ${login.body}`);
  const verify = await client.post('/admin/v1/auth/mfa/verify', {
    mfaToken: login.json().data.mfaToken,
    code: nextTotp(ctx.clock, admin.totpSecret),
  });
  if (verify.statusCode !== 200) throw new Error(`staff mfa failed: ${verify.body}`);
  client.token = verify.json().data.accessToken;
  return verify.json().data;
}

export interface MerchantUser {
  readonly client: Client;
  readonly email: string;
  readonly userId: string;
  readonly merchantId: string;
}

/** Registers a merchant user (owner of a new draft merchant) and logs them in. */
export async function registerMerchantUser(
  ctx: TestContext,
  label = 'owner'
): Promise<MerchantUser> {
  const client = new Client(ctx.app);
  const email = uniqueEmail(label);
  const res = await client.post('/merchant/v1/auth/register', {
    email,
    password: PASSWORD,
    name: `User ${label}`,
    merchant: { legalName: `${label} Ltd`, country: 'UG', defaultCurrency: 'UGX' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const { user, merchant } = res.json().data;
  await loginMerchantUser(client, email);
  return { client, email, userId: user.id, merchantId: merchant.id };
}

export async function loginMerchantUser(client: Client, email: string, merchant?: string) {
  const res = await client.post('/merchant/v1/auth/login', {
    email,
    password: PASSWORD,
    ...(merchant ? { merchant } : {}),
  });
  if (res.statusCode !== 200 || res.json().data.status !== 'authenticated') {
    throw new Error(`login failed: ${res.body}`);
  }
  client.token = res.json().data.accessToken;
  return res.json().data;
}

/** Invites `email` into the inviter's merchant with `role` and accepts as a new account. */
export async function addTeamMember(
  ctx: TestContext,
  inviter: MerchantUser,
  role: 'admin' | 'developer' | 'finance' | 'support' | 'viewer'
): Promise<MerchantUser> {
  const email = uniqueEmail(role);
  const invite = await inviter.client.post('/merchant/v1/team/invites', { email, role });
  if (invite.statusCode !== 201) throw new Error(`invite failed: ${invite.body}`);
  const client = new Client(ctx.app);
  const accept = await client.post('/merchant/v1/auth/accept-invite', {
    token: invite.json().data.token,
    name: `Member ${role}`,
    password: PASSWORD,
  });
  if (accept.statusCode !== 200) throw new Error(`accept failed: ${accept.body}`);
  await loginMerchantUser(client, email, inviter.merchantId);
  return { client, email, userId: accept.json().data.userId, merchantId: inviter.merchantId };
}

/** Admin moves a draft merchant to active. KYC (Phase 7) will do this; tests use SQL. */
export async function activateMerchantDirectly(superuserUrl: string, merchantRef: string) {
  const { Client: PgClient } = await import('pg');
  const pg = new PgClient({ connectionString: superuserUrl });
  await pg.connect();
  try {
    await pg.query("update core.merchants set status = 'active', kyc_level = 1 where ref = $1", [
      merchantRef,
    ]);
  } finally {
    await pg.end();
  }
}
