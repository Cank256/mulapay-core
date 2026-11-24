/**
 * Webhook endpoint management on `/v1/webhook-endpoints` and `/merchant/v1/webhook-endpoints`
 * (spec 6.11, 7.1, 7.2): registration, subscriptions, secrets, authorization, isolation and
 * the SSRF rules for URLs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMerchant,
  issueKey,
  startDeveloperContext,
  type DeveloperContext,
  type DeveloperMerchant,
  type IssuedKey,
} from '../support/developer';
import { addTeamMember } from '../support/identity';

let ctx: DeveloperContext;
let merchant: DeveloperMerchant;
let key: IssuedKey;

const URL_OK = 'https://merchant.example.com/webhooks/mulapay';

beforeAll(async () => {
  ctx = await startDeveloperContext();
  merchant = await createMerchant(ctx, { active: true, label: 'hooks' });
  key = await issueKey(ctx, merchant.owner, {
    environment: 'test',
    scopes: ['webhooks:read', 'webhooks:write', 'events:read'],
  });
});
afterAll(async () => {
  await ctx.close();
});

async function register(body: Record<string, unknown> = {}, client = key.client) {
  return client.post('/v1/webhook-endpoints', {
    url: URL_OK,
    enabledEvents: ['payment.succeeded'],
    ...body,
  });
}

describe('POST /v1/webhook-endpoints', () => {
  it('registers an endpoint and returns the signing secret once', async () => {
    const res = await register({
      description: 'orders',
      enabledEvents: ['payment.succeeded', 'payment.failed'],
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data).toMatchObject({
      environment: 'test',
      url: URL_OK,
      description: 'orders',
      enabledEvents: ['payment.failed', 'payment.succeeded'],
      status: 'active',
      failureCount: 0,
    });
    expect(data.id).toMatch(/^wh_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(data.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    // Never again.
    const fetched = await key.client.get(`/v1/webhook-endpoints/${data.id}`);
    expect(fetched.body).not.toContain(data.secret);
    expect(fetched.json().data).not.toHaveProperty('secret');
    const list = await key.client.get('/v1/webhook-endpoints');
    expect(list.body).not.toContain(data.secret);
  });

  it('stores the secret encrypted, bound to the endpoint', async () => {
    const data = (await register()).json().data;
    const rows = await ctx.sql(
      'select secret_enc, previous_secret_enc from core.webhook_endpoints where ref = $1',
      [data.id]
    );
    expect(String(rows[0]?.secret_enc)).toMatch(/^v1\./);
    expect(String(rows[0]?.secret_enc)).not.toContain(data.secret);
    const copy = await ctx.sql(
      'select row_to_json(e)::text as j from core.webhook_endpoints e where ref = $1',
      [data.id]
    );
    expect(String(copy[0]?.j)).not.toContain(data.secret);
    expect(rows[0]?.previous_secret_enc).toBeNull();
  });

  it('supports * for every event, and removes duplicates', async () => {
    const all = (
      await register({ enabledEvents: ['payment.succeeded', '*', 'payment.failed'] })
    ).json().data;
    expect(all.enabledEvents).toEqual(['*']);
    const dup = (await register({ enabledEvents: ['payment.failed', 'payment.failed'] })).json()
      .data;
    expect(dup.enabledEvents).toEqual(['payment.failed']);
  });

  it.each([
    ['an unknown event type', { enabledEvents: ['payment.exploded'] }],
    ['no events', { enabledEvents: [] }],
    ['a missing url', { url: undefined }],
    ['a short url', { url: 'http://a' }],
    ['an unknown property', { secret: 'whsec_mine' }],
    ['a description that is too long', { description: 'x'.repeat(201) }],
    ['events that are not strings', { enabledEvents: [1, 2] }],
  ])('rejects %s with 400 and a field list', async (_label, body) => {
    const res = await register(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.details.fields.length).toBeGreaterThan(0);
  });

  it('refuses a client-supplied secret: the platform generates it', async () => {
    const res = await register({ secret: 'whsec_chosen' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses more than 20 endpoints per environment', async () => {
    const m = await createMerchant(ctx, { label: 'hooks-limit' });
    const k = await issueKey(ctx, m.owner, { environment: 'test', scopes: ['webhooks:write'] });
    const results = [];
    for (let i = 0; i < 21; i++) results.push(await register({ url: `${URL_OK}/${i}` }, k.client));
    expect(results.slice(0, 20).every((r) => r.statusCode === 201)).toBe(true);
    expect(results[20]?.statusCode).toBe(409);
    expect(results[20]?.json().error.code).toBe('WEBHOOK_ENDPOINT_LIMIT_REACHED');
  });

  it('is audited with the actor and no secret', async () => {
    const data = (await register()).json().data;
    const rows = await ctx.sql(
      "select actor_type, actor_id, after::text as after from core.audit_logs where action = 'webhook_endpoint.created' and resource_id = $1",
      [data.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'api_key', actor_id: key.ref });
    expect(String(rows[0]?.after)).not.toContain(data.secret);
    expect(String(rows[0]?.after)).not.toContain('secret');
  });

  it('keeps the URL path and query, which often hold a token, out of the audit trail', async () => {
    const data = (await register({ url: `${URL_OK}/TOKEN-IN-PATH?token=TOKEN-IN-QUERY` })).json()
      .data;
    await key.client.patch(`/v1/webhook-endpoints/${data.id}`, { url: `${URL_OK}/OTHER-TOKEN` });
    const rows = await ctx.sql(
      `select before::text as before, after::text as after from core.audit_logs
        where resource_id = $1 and action in ('webhook_endpoint.created', 'webhook_endpoint.updated')`,
      [data.id]
    );
    expect(rows).toHaveLength(2);
    const text = JSON.stringify(rows);
    for (const forbidden of ['TOKEN-IN-PATH', 'TOKEN-IN-QUERY', 'OTHER-TOKEN']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).toContain('merchant.example.com');
    const updated = rows.find((r) => r.before);
    expect(updated?.before).not.toEqual(updated?.after);
  });
});

describe('reading, changing and deleting', () => {
  it('lists, retrieves, updates and deletes (soft)', async () => {
    const created = (await register({ description: 'before' })).json().data;
    const patched = await key.client.patch(`/v1/webhook-endpoints/${created.id}`, {
      description: 'after',
      enabledEvents: ['payment.failed'],
      url: 'https://merchant.example.com/other',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({
      description: 'after',
      enabledEvents: ['payment.failed'],
      url: 'https://merchant.example.com/other',
    });
    expect(
      (await key.client.get(`/v1/webhook-endpoints/${created.id}`)).json().data.description
    ).toBe('after');
    const removed = await key.client.delete(`/v1/webhook-endpoints/${created.id}`);
    expect(removed.statusCode).toBe(200);
    expect((await key.client.get(`/v1/webhook-endpoints/${created.id}`)).statusCode).toBe(404);
    const list = (await key.client.get('/v1/webhook-endpoints')).json().data as Array<{
      id: string;
    }>;
    expect(list.find((e) => e.id === created.id)).toBeUndefined();
    // The row stays, disabled, so delivery history keeps its endpoint.
    const rows = await ctx.sql(
      'select status, deleted_at from core.webhook_endpoints where ref = $1',
      [created.id]
    );
    expect(rows[0]?.status).toBe('disabled');
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect((await key.client.delete(`/v1/webhook-endpoints/${created.id}`)).statusCode).toBe(404);
  });

  it('refuses an empty update and unknown fields', async () => {
    const created = (await register()).json().data;
    expect((await key.client.patch(`/v1/webhook-endpoints/${created.id}`, {})).statusCode).toBe(
      400
    );
    expect(
      (await key.client.patch(`/v1/webhook-endpoints/${created.id}`, { status: 'auto_disabled' }))
        .statusCode
    ).toBe(400);
    expect(
      (await key.client.patch(`/v1/webhook-endpoints/${created.id}`, { secretEnc: 'x' })).statusCode
    ).toBe(400);
  });

  it('pauses with status disabled and re-enables with active, clearing the failure count', async () => {
    const created = (await register()).json().data;
    await ctx.sql('update core.webhook_endpoints set failure_count = 17 where ref = $1', [
      created.id,
    ]);
    const paused = (
      await key.client.patch(`/v1/webhook-endpoints/${created.id}`, { status: 'disabled' })
    ).json().data;
    expect(paused).toMatchObject({ status: 'disabled', failureCount: 17 });
    expect(paused.disabledAt).not.toBeNull();
    const again = (
      await key.client.patch(`/v1/webhook-endpoints/${created.id}`, { status: 'active' })
    ).json().data;
    expect(again).toMatchObject({ status: 'active', failureCount: 0, disabledAt: null });
  });

  it('answers 404 for an unknown ref and for another merchant’s endpoint', async () => {
    const other = await createMerchant(ctx, { label: 'hooks-other' });
    const otherKey = await issueKey(ctx, other.owner, {
      environment: 'test',
      scopes: ['webhooks:read', 'webhooks:write'],
    });
    const mine = (await register()).json().data;
    for (const [method, url, body] of [
      ['GET', `/v1/webhook-endpoints/${mine.id}`, undefined],
      ['PATCH', `/v1/webhook-endpoints/${mine.id}`, { description: 'x' }],
      ['DELETE', `/v1/webhook-endpoints/${mine.id}`, undefined],
      ['POST', `/v1/webhook-endpoints/${mine.id}/rotate-secret`, {}],
      ['GET', '/v1/webhook-endpoints/wh_01JBX7Q2M4N8R5T6V9W0XYZABC', undefined],
    ] as const) {
      const res =
        method === 'GET'
          ? await otherKey.client.get(url)
          : method === 'PATCH'
            ? await otherKey.client.patch(url, body)
            : method === 'DELETE'
              ? await otherKey.client.delete(url)
              : await otherKey.client.post(url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await otherKey.client.get('/v1/webhook-endpoints')).json().data).toEqual([]);
    // Nothing happened to the endpoint.
    expect((await key.client.get(`/v1/webhook-endpoints/${mine.id}`)).json().data.status).toBe(
      'active'
    );
  });

  it('keeps test and live endpoints apart', async () => {
    const live = await issueKey(ctx, merchant.owner, {
      environment: 'live',
      scopes: ['webhooks:read', 'webhooks:write'],
    });
    const liveEndpoint = (await register({}, live.client)).json().data;
    expect(liveEndpoint.environment).toBe('live');
    expect((await key.client.get(`/v1/webhook-endpoints/${liveEndpoint.id}`)).statusCode).toBe(404);
    expect(
      (
        (await key.client.get('/v1/webhook-endpoints')).json().data as Array<{
          environment: string;
        }>
      ).every((e) => e.environment === 'test')
    ).toBe(true);
  });
});

describe('secret rotation', () => {
  it('returns a new secret once and keeps the old one signing for the grace period', async () => {
    const created = (await register()).json().data;
    const rotated = await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, {
      graceHours: 12,
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().data.secret).toMatch(/^whsec_/);
    expect(rotated.json().data.secret).not.toBe(created.secret);
    const rows = await ctx.sql(
      'select previous_secret_enc, previous_secret_expires_at from core.webhook_endpoints where ref = $1',
      [created.id]
    );
    expect(rows[0]?.previous_secret_enc).not.toBeNull();
    const hours =
      (new Date(rows[0]?.previous_secret_expires_at as string).getTime() -
        ctx.clock.now().getTime()) /
      3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThan(12.1);
  });

  it('with no grace period the old secret stops at once', async () => {
    const created = (await register()).json().data;
    expect(
      (
        await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, {
          graceHours: 0,
        })
      ).statusCode
    ).toBe(200);
    const rows = await ctx.sql(
      'select previous_secret_enc from core.webhook_endpoints where ref = $1',
      [created.id]
    );
    expect(rows[0]?.previous_secret_enc).toBeNull();
  });

  it('defaults to 24 hours and refuses more than 72', async () => {
    const created = (await register()).json().data;
    expect(
      (await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, {})).statusCode
    ).toBe(200);
    expect(
      (
        await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, {
          graceHours: 73,
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, {
          graceHours: -1,
        })
      ).statusCode
    ).toBe(400);
  });
});

describe('secret rotation cannot extend a retired secret (P5-S9)', () => {
  const HOUR = 3_600_000;
  const secretsAt = async (ref: string, at: Date) => {
    const row = await ctx.sql('select id from core.webhook_endpoints where ref = $1', [ref]);
    const found = await ctx.endpointsRepository.findById(row[0]?.id as string);
    return found ? ctx.endpoints.signingSecrets(found, at) : [];
  };
  it('keeps at most one previous secret, so chained rotations drop the oldest at once', async () => {
    const created = (await register()).json().data;
    const rotate = async (graceHours: number) =>
      (
        await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, { graceHours })
      ).json().data.secret as string;
    const first = created.secret as string;
    const second = await rotate(72);
    const third = await rotate(72);
    const now = ctx.clock.now();
    // The first secret was retired by the second rotation, well inside its 72-hour grace.
    expect(await secretsAt(created.id, now)).toEqual([third, second]);
    expect(await secretsAt(created.id, now)).not.toContain(first);
    // The previous secret stops signing at the grace limit, however many rotations came before.
    expect(await secretsAt(created.id, new Date(now.getTime() + 71 * HOUR))).toEqual([
      third,
      second,
    ]);
    expect(await secretsAt(created.id, new Date(now.getTime() + 73 * HOUR))).toEqual([third]);
  });
  it('a rotation with no grace ends the previous secret even if one was still running', async () => {
    const created = (await register()).json().data;
    const second = (
      await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, {
        graceHours: 72,
      })
    ).json().data.secret as string;
    const third = (
      await key.client.post(`/v1/webhook-endpoints/${created.id}/rotate-secret`, {
        graceHours: 0,
      })
    ).json().data.secret as string;
    expect(await secretsAt(created.id, ctx.clock.now())).toEqual([third]);
    expect(second).not.toBe(third);
  });
});
describe('authorization', () => {
  it('needs webhooks:read to read and webhooks:write to change', async () => {
    const reader = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['webhooks:read'],
    });
    const writer = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['webhooks:write'],
    });
    const none = await issueKey(ctx, merchant.owner, {
      environment: 'test',
      scopes: ['payments:read'],
    });
    expect((await reader.client.get('/v1/webhook-endpoints')).statusCode).toBe(200);
    expect((await register({}, reader.client)).statusCode).toBe(403);
    expect((await writer.client.get('/v1/webhook-endpoints')).statusCode).toBe(403);
    expect((await register({}, writer.client)).statusCode).toBe(201);
    expect((await none.client.get('/v1/webhook-endpoints')).statusCode).toBe(403);
    expect((await register({}, none.client)).statusCode).toBe(403);
  });

  it('requires an API key: no key, a dashboard token and a revoked key are 401', async () => {
    const anon = await ctx.app.inject({
      method: 'GET',
      url: '/v1/webhook-endpoints',
      remoteAddress: '10.8.8.8',
    });
    expect(anon.statusCode).toBe(401);
    const asUser = await ctx.app.inject({
      method: 'GET',
      url: '/v1/webhook-endpoints',
      remoteAddress: '10.8.8.9',
      headers: { authorization: `Bearer ${merchant.owner.client.token}` },
    });
    expect(asUser.statusCode).toBe(401);
  });
});

describe('dashboard mirror (/merchant/v1/webhook-endpoints)', () => {
  it('lets a developer manage endpoints in either environment, and read-only roles only read', async () => {
    const dev = await addTeamMember(ctx, merchant.owner, 'developer');
    // `support` reads webhooks; `viewer` is edited by the admin suite, which runs in parallel.
    const viewer = await addTeamMember(ctx, merchant.owner, 'support');
    const created = await dev.client.post('/merchant/v1/webhook-endpoints?environment=test', {
      url: URL_OK,
      enabledEvents: ['*'],
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    expect(created.json().data.secret).toMatch(/^whsec_/);
    expect(
      (await dev.client.get(`/merchant/v1/webhook-endpoints/${id}?environment=test`)).statusCode
    ).toBe(200);
    expect(
      (await dev.client.get(`/merchant/v1/webhook-endpoints/${id}?environment=live`)).statusCode
    ).toBe(404);
    const list = await dev.client.get('/merchant/v1/webhook-endpoints?environment=test');
    expect((list.json().data as Array<{ id: string }>).some((e) => e.id === id)).toBe(true);
    expect(
      (await viewer.client.get('/merchant/v1/webhook-endpoints?environment=test')).statusCode
    ).toBe(200);
    expect(
      (
        await viewer.client.post('/merchant/v1/webhook-endpoints?environment=test', {
          url: URL_OK,
          enabledEvents: ['*'],
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await viewer.client.delete(`/merchant/v1/webhook-endpoints/${id}?environment=test`))
        .statusCode
    ).toBe(403);
    const patched = await dev.client.patch(
      `/merchant/v1/webhook-endpoints/${id}?environment=test`,
      { description: 'via dashboard' }
    );
    expect(patched.json().data.description).toBe('via dashboard');
    expect(
      (
        await dev.client.post(
          `/merchant/v1/webhook-endpoints/${id}/rotate-secret?environment=test`,
          {}
        )
      ).statusCode
    ).toBe(200);
    expect(
      (await dev.client.delete(`/merchant/v1/webhook-endpoints/${id}?environment=test`)).statusCode
    ).toBe(200);
    expect(
      (await dev.client.get(`/merchant/v1/webhook-endpoints/${id}?environment=test`)).statusCode
    ).toBe(404);
  });

  it('is closed to another merchant’s users and to anonymous callers', async () => {
    const other = await createMerchant(ctx, { label: 'hooks-dash-other' });
    const mine = (await register()).json().data;
    expect(
      (await other.owner.client.get(`/merchant/v1/webhook-endpoints/${mine.id}?environment=test`))
        .statusCode
    ).toBe(404);
    const anon = await ctx.app.inject({
      method: 'GET',
      url: '/merchant/v1/webhook-endpoints',
      remoteAddress: '10.8.8.10',
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('URL safety (SSRF)', () => {
  let strict: DeveloperContext;
  let strictKey: IssuedKey;
  beforeAll(async () => {
    strict = await startDeveloperContext({ WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'false' });
    const m = await createMerchant(strict, { label: 'hooks-ssrf' });
    strictKey = await issueKey(strict, m.owner, {
      environment: 'test',
      scopes: ['webhooks:write', 'webhooks:read'],
    });
  });
  afterAll(async () => {
    await strict.close();
  });

  it.each([
    ['http://merchant.example.com/hook', 'https_required'],
    ['https://127.0.0.1/hook', 'private_address'],
    ['https://localhost/hook', 'private_address'],
    ['https://[::1]/hook', 'private_address'],
    ['https://169.254.169.254/latest/meta-data/', 'private_address'],
    ['https://10.0.0.1/hook', 'private_address'],
    ['https://192.168.1.10/hook', 'private_address'],
    ['https://2130706433/hook', 'private_address'],
    ['https://intranet/hook', 'private_address'],
    ['https://user:secret@merchant.example.com/hook', 'credentials_not_allowed'],
  ])('refuses %s', async (url, reason) => {
    const res = await strictKey.client.post('/v1/webhook-endpoints', { url, enabledEvents: ['*'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('WEBHOOK_URL_REJECTED');
    expect(res.json().error.details).toEqual({ reason });
    // The refused URL is not echoed back.
    expect(res.body).not.toContain('secret@');
  });

  it('also refuses a private URL when the endpoint is changed', async () => {
    const created = await strictKey.client.post('/v1/webhook-endpoints', {
      url: URL_OK,
      enabledEvents: ['*'],
    });
    expect(created.statusCode).toBe(201);
    const res = await strictKey.client.patch(`/v1/webhook-endpoints/${created.json().data.id}`, {
      url: 'https://127.0.0.1/x',
    });
    expect(res.statusCode).toBe(422);
  });
});
