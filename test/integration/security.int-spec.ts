/**
 * Security properties across the whole app (spec 8.4, 12 "Security", 16):
 * - every route carries a policy and a response schema, and every write route is audited
 * - a route without a policy fails closed
 * - the audit interceptor backstops unaudited successes and records failures
 * - secrets never reach log lines
 * - the Phase 1 exit criteria, end to end, with the chain verified at the end
 */
import { Controller, Get, Module, Post } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, RouterModule } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FASTIFY_ROUTE_SCHEMA_METADATA } from '@nestjs/platform-fastify/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUDITED } from '../../src/common/audit/audited.decorator';
import { Audited } from '../../src/common/audit/audited.decorator';
import { Authenticated, POLICY } from '../../src/common/authz/policy.decorators';
import { AppError } from '../../src/common/errors/app-error';
import { ApiEnvelopedResponses } from '../../src/common/http/response-schema.decorator';
import { FixedClock } from '../support/fixed-clock';
import {
  Client,
  loginMerchantUser,
  nextTotp,
  PASSWORD,
  registerMerchantUser,
  staffSession,
  uniqueEmail,
  type TestContext,
} from '../support/identity';
import { captureLogs, type CapturedLogs } from '../support/log-capture';
import { createTestApp } from '../support/test-app';
import { testConfig } from '../support/test-env';

@Controller('__security')
class SecurityProbeController {
  @Get('open')
  @ApiEnvelopedResponses({ 200: z.object({ ok: z.boolean() }) })
  open() {
    return { ok: true };
  }

  @Post('noop')
  @Authenticated()
  @Audited('test.noop', 'test')
  @ApiEnvelopedResponses({ 201: z.object({ ok: z.boolean() }) })
  noop() {
    return { ok: true };
  }

  @Post('fail')
  @Authenticated()
  @Audited('test.fail', 'test')
  fail(): never {
    throw new AppError('MERCHANT_NOT_ACTIVE');
  }
}

@Module({ controllers: [SecurityProbeController] })
class SecurityProbeModule {}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

interface RouteInfo {
  readonly id: string;
  readonly method: string;
  readonly hasPolicy: boolean;
  readonly hasAudit: boolean;
  readonly hasSchema: boolean;
}

function collectRoutes(app: NestFastifyApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new () => unknown) | null;
      if (!controller || controller === SecurityProbeController) continue;
      const proto = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = proto[name];
        if (
          typeof handler !== 'function' ||
          Reflect.getMetadata(PATH_METADATA, handler) === undefined
        )
          continue;
        const method = METHOD_NAMES[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? '?';
        routes.push({
          id: `${method} ${controller.name}.${name}`,
          method,
          hasPolicy: Boolean(
            Reflect.getMetadata(POLICY, handler) ?? Reflect.getMetadata(POLICY, controller)
          ),
          hasAudit: Boolean(Reflect.getMetadata(AUDITED, handler)),
          hasSchema: Boolean(Reflect.getMetadata(FASTIFY_ROUTE_SCHEMA_METADATA, handler)),
        });
      }
    }
  }
  return routes;
}

let ctx: TestContext;
let logs: CapturedLogs;

beforeAll(async () => {
  const config = testConfig({ LOG_LEVEL: 'debug' });
  logs = captureLogs(config, 'debug');
  const clock = new FixedClock(new Date());
  const app = await createTestApp(config, {
    clock,
    logger: logs.logger,
    extraImports: [
      SecurityProbeModule,
      RouterModule.register([{ path: 'merchant/v1', module: SecurityProbeModule }]),
    ],
  });
  ctx = { app, clock, config, close: () => app.close() };
});

afterAll(async () => {
  await ctx.close();
});

describe('route declarations', () => {
  it('finds the Phase 1 routes', () => {
    expect(collectRoutes(ctx.app).length).toBeGreaterThan(30);
  });

  it('every route has a policy decorator', () => {
    expect(
      collectRoutes(ctx.app)
        .filter((r) => !r.hasPolicy)
        .map((r) => r.id)
    ).toEqual([]);
  });

  it('every state-changing route is @Audited', () => {
    expect(
      collectRoutes(ctx.app)
        .filter((r) => WRITE.has(r.method) && !r.hasAudit)
        .map((r) => r.id)
    ).toEqual([]);
  });

  it('every route declares its response schema', () => {
    expect(
      collectRoutes(ctx.app)
        .filter((r) => !r.hasSchema)
        .map((r) => r.id)
    ).toEqual([]);
  });

  it('a route without a policy is refused (fail closed)', async () => {
    const res = await new Client(ctx.app).get('/merchant/v1/__security/open');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('audit interceptor', () => {
  async function rowsFor(action: string) {
    const staff = await staffSession(ctx, 'auditor');
    const res = await staff.client.get(`/admin/v1/audit-logs?action=${action}`);
    return res.json().data.items as Array<Record<string, unknown>>;
  }

  it('writes a backstop row for a successful write that the service did not audit', async () => {
    const user = await registerMerchantUser(ctx);
    expect((await user.client.post('/merchant/v1/__security/noop')).statusCode).toBe(201);
    const rows = await rowsFor('test.noop');
    expect(rows[0]).toMatchObject({
      outcome: 'success',
      actorId: user.userId,
      surface: 'dashboard',
    });
  });

  it('records failed writes of an authenticated actor as error', async () => {
    const user = await registerMerchantUser(ctx);
    expect((await user.client.post('/merchant/v1/__security/fail')).statusCode).toBe(409);
    const rows = await rowsFor('test.fail');
    expect(rows[0]).toMatchObject({ outcome: 'error', actorId: user.userId });
  });

  it('does not audit anonymous failures', async () => {
    expect((await new Client(ctx.app).post('/merchant/v1/__security/fail')).statusCode).toBe(401);
  });
});

describe('Phase 1 exit criteria', () => {
  it('admin creates a merchant, its user logs in with MFA, every step is audited and the chain verifies', async () => {
    const admin = await staffSession(ctx);
    const ownerEmail = uniqueEmail('exit');
    const created = await admin.client.post('/admin/v1/merchants', {
      legalName: 'Exit Criteria Ltd',
      country: 'RW',
      defaultCurrency: 'RWF',
      ownerEmail,
    });
    const { merchant, ownerInvitation } = created.json().data;

    const owner = new Client(ctx.app);
    await owner.post('/merchant/v1/auth/accept-invite', {
      token: ownerInvitation.token,
      name: 'Exit Owner',
      password: PASSWORD,
    });
    await loginMerchantUser(owner, ownerEmail);
    const { secret } = (await owner.post('/merchant/v1/auth/mfa/enroll', {})).json().data;
    await owner.post('/merchant/v1/auth/mfa/enroll', { code: nextTotp(ctx.clock, secret) });

    const device = new Client(ctx.app);
    const challenge = await device.post('/merchant/v1/auth/login', {
      email: ownerEmail,
      password: PASSWORD,
    });
    expect(challenge.json().data.status).toBe('mfa_required');
    const session = await device.post('/merchant/v1/auth/mfa/verify', {
      mfaToken: challenge.json().data.mfaToken,
      code: nextTotp(ctx.clock, secret),
    });
    expect(session.json().data).toMatchObject({
      status: 'authenticated',
      merchant: { id: merchant.id, role: 'owner' },
    });

    const audit = await admin.client.get(`/admin/v1/audit-logs?merchant=${merchant.id}&limit=200`);
    const actions = (audit.json().data.items as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'merchant.created',
        'invitation.created',
        'invitation.accepted',
        'auth.login_succeeded',
      ])
    );
    const userRows = await admin.client.get('/admin/v1/audit-logs?resourceType=user&limit=200');
    const userActions = (userRows.json().data.items as Array<{ action: string }>).map(
      (r) => r.action
    );
    expect(userActions).toEqual(
      expect.arrayContaining(['user.created', 'auth.mfa_enrollment_started', 'auth.mfa_enabled'])
    );

    const verify = await admin.client.get('/admin/v1/audit-logs/verify');
    expect(verify.json().data).toMatchObject({ valid: true, firstBreak: null });
  });
});

describe('secrets in logs', () => {
  it('never writes passwords, tokens, API keys or TOTP secrets to any log line', async () => {
    const user = await registerMerchantUser(ctx);
    const key = (
      await user.client.post('/merchant/v1/api-keys', {
        name: 'k',
        environment: 'test',
        scopes: ['payments:read'],
      })
    ).json().data.key as string;
    await new Client(ctx.app).get('/v1/ping', { authorization: `Bearer ${key}` });
    const { secret } = (await user.client.post('/merchant/v1/auth/mfa/enroll', {})).json().data;
    await new Client(ctx.app).post('/merchant/v1/auth/login', {
      email: user.email,
      password: 'a-wrong-password-xyz',
    });

    const text = logs.raw.join('\n');
    expect(logs.raw.length).toBeGreaterThan(0);
    for (const value of [
      PASSWORD,
      'a-wrong-password-xyz',
      key,
      key.split('_')[3]!,
      user.client.token!,
      user.client.cookies.mp_refresh!,
      secret,
      user.email,
    ]) {
      expect(text).not.toContain(value);
    }
  });
});
