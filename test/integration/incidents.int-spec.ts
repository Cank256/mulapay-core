/**
 * Incidents (spec 6.14): severity, affected services and merchants, the timeline of internal and
 * public updates, status, postmortem, and the public status feed, which must carry the public
 * updates and nothing internal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffSession } from '../support/identity';
import { createTestMerchant, type TestMerchant } from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';

let ctx: SupportContext;
let merchant: TestMerchant;

beforeAll(async () => {
  ctx = await startSupportContext();
  merchant = await createTestMerchant(ctx, { label: 'affected' });
});
afterAll(async () => {
  await ctx?.close();
});

const feed = async () => {
  const res = await ctx.app.inject({ method: 'GET', url: '/v1/status' });
  return res;
};
const idOf = async (ref: string) =>
  (await ctx.query<{ id: string }>(`select id from core.users where ref = $1`, [ref]))[0]!.id;

const SECRET_TITLE = 'Double posting in the ledger after the Acme rollout';
const INTERNAL_IMPACT =
  'Ledger entries for Acme are posted twice by the gateway consumer; reverse them by hand.';
const INTERNAL_NOTE = 'Root cause is probably the consumer retry; do not tell merchants yet.';

describe('the incident lifecycle', () => {
  it('opens an incident with severity, services, merchants and a commander, and tells staff', async () => {
    const ops = await staffSession(ctx, 'operations');
    const commander = await staffSession(ctx, 'super_admin');
    const res = await ops.client.post('/admin/v1/incidents', {
      title: SECRET_TITLE,
      severity: 'sev2',
      impact: INTERNAL_IMPACT,
      affectedServices: ['payments', 'ledger', 'gateway'],
      affectedMerchants: [merchant.ref],
      commander: commander.admin.userId,
      message: 'Investigating',
    });
    expect(res.statusCode).toBe(201);
    const incident = res.json().data;
    expect(incident).toMatchObject({
      status: 'investigating',
      severity: 'sev2',
      source: 'manual',
      public: false,
      affectedServices: ['payments', 'ledger', 'gateway'],
      affectedMerchants: [merchant.ref],
      commander: commander.admin.userId,
    });
    expect(incident.updates).toHaveLength(1);
    // A sev2 incident notifies staff on both channels (it is required).
    const told = await ctx.query<{ channel: string }>(
      `select channel from core.notifications where recipient_id = $1 and template_code = 'incident.opened' and resource_key = $2`,
      [await idOf(commander.admin.userId), incident.id]
    );
    expect(told.map((t) => t.channel).sort()).toEqual(['email', 'in_app']);
    const audit = await ctx.query(
      `select 1 from core.audit_logs where action = 'incident.opened' and resource_id = $1`,
      [incident.id]
    );
    expect(audit).toHaveLength(1);
  });

  it('refuses an unknown service, a future start, and a role that may only read', async () => {
    const ops = await staffSession(ctx, 'operations');
    const base = { title: 't', severity: 'sev3', impact: 'i' };
    const bad = await ops.client.post('/admin/v1/incidents', {
      ...base,
      affectedServices: ['coffee-machine'],
    });
    expect(bad.statusCode).toBe(400);
    const future = await ops.client.post('/admin/v1/incidents', {
      ...base,
      affectedServices: [],
      startedAt: new Date(ctx.clock.now().getTime() + 3_600_000).toISOString(),
    });
    expect(future.statusCode).toBe(422);
    expect(future.json().error.details.reason).toBe('started_in_future');
    const unknownMerchant = await ops.client.post('/admin/v1/incidents', {
      ...base,
      affectedMerchants: ['mch_01NOSUCHMERCHANT00000000000'],
    });
    expect(unknownMerchant.statusCode).toBe(422);

    const agent = await staffSession(ctx, 'support_agent');
    expect((await agent.client.get('/admin/v1/incidents')).statusCode).toBe(200);
    expect(
      (await agent.client.post('/admin/v1/incidents', { ...base, affectedServices: [] })).statusCode
    ).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/v1/incidents' })).statusCode).toBe(
      401
    );
  });

  it('walks the statuses, keeps a timeline, and is final once resolved', async () => {
    const ops = await staffSession(ctx, 'operations');
    const created = (
      await ops.client.post('/admin/v1/incidents', {
        title: 'Slow webhooks',
        severity: 'sev3',
        impact: 'Delays',
        affectedServices: ['webhooks'],
      })
    ).json().data;
    const identified = await ops.client.patch(`/admin/v1/incidents/${created.id}`, {
      status: 'identified',
    });
    expect(identified.json().data.status).toBe('identified');
    ctx.clock.advanceBy(1000);
    const updated = await ops.client.post(`/admin/v1/incidents/${created.id}/updates`, {
      body: 'Fix deployed',
      status: 'monitoring',
    });
    expect(updated.json().data.status).toBe('monitoring');
    ctx.clock.advanceBy(1000);
    const resolved = await ops.client.post(`/admin/v1/incidents/${created.id}/resolve`, {
      body: 'Recovered',
    });
    expect(resolved.json().data).toMatchObject({ status: 'resolved' });
    expect(resolved.json().data.resolvedAt).toEqual(expect.any(String));
    expect(resolved.json().data.updates.map((u: { status: string }) => u.status)).toEqual([
      'investigating',
      'identified',
      'monitoring',
      'resolved',
    ]);
    const late = await ops.client.post(`/admin/v1/incidents/${created.id}/updates`, {
      body: 'late',
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('INCIDENT_TRANSITION_INVALID');
    expect(
      (await ops.client.patch(`/admin/v1/incidents/${created.id}`, { severity: 'sev1' })).statusCode
    ).toBe(409);
    await expect(ctx.query(`update core.incident_updates set body = 'x'`)).rejects.toThrow();
    const listed = await ops.client.get('/admin/v1/incidents?open=false&limit=200');
    expect(listed.json().data.items.map((i: { id: string }) => i.id)).toContain(created.id);
  });
});

describe('the public status feed', () => {
  it('is open, shows nothing for an internal incident, and then only what staff made public', async () => {
    const ops = await staffSession(ctx, 'operations');
    const opened = (
      await ops.client.post('/admin/v1/incidents', {
        title: SECRET_TITLE,
        severity: 'sev2',
        impact: INTERNAL_IMPACT,
        affectedServices: ['payments', 'ledger', 'gateway', 'database'],
        affectedMerchants: [merchant.ref],
        commander: ops.admin.userId,
      })
    ).json().data;

    // An internal incident, and an internal update, are not on the feed.
    ctx.clock.advanceBy(1000);
    await ops.client.post(`/admin/v1/incidents/${opened.id}/updates`, { body: INTERNAL_NOTE });
    const quiet = await feed();
    expect(quiet.statusCode).toBe(200);
    expect(quiet.headers['cache-control']).toBe('public, max-age=30');
    expect(quiet.body).not.toContain(opened.id);
    expect(quiet.json().data.incidents.map((i: { id: string }) => i.id)).not.toContain(opened.id);

    // A public update makes it public, with that text as the headline.
    ctx.clock.advanceBy(1000);
    await ops.client.post(`/admin/v1/incidents/${opened.id}/updates`, {
      body: 'Some payments are failing. We are working on it.',
      public: true,
      status: 'identified',
    });
    const loud = await feed();
    const entry = loud.json().data.incidents.find((i: { id: string }) => i.id === opened.id);
    expect(entry).toMatchObject({
      headline: 'Some payments are failing. We are working on it.',
      status: 'identified',
      impact: 'major',
      components: ['Payments'],
      resolvedAt: null,
    });
    expect(entry.updates).toEqual([
      expect.objectContaining({
        status: 'identified',
        body: 'Some payments are failing. We are working on it.',
      }),
    ]);
    expect(loud.json().data.status).toBe('major_outage');

    // Nothing internal is anywhere in the response, whatever the field.
    for (const secret of [
      SECRET_TITLE,
      INTERNAL_IMPACT,
      INTERNAL_NOTE,
      merchant.ref,
      ops.admin.userId,
      'sev2',
      'ledger',
      'Ledger',
      'gateway',
      'database',
      'commander',
      'postmortem',
    ]) {
      expect(loud.body).not.toContain(secret);
    }
    expect(Object.keys(entry).sort()).toEqual(
      [
        'components',
        'headline',
        'id',
        'impact',
        'resolvedAt',
        'startedAt',
        'status',
        'updates',
      ].sort()
    );

    // De-escalating changes the public impact; the severity itself is never shown.
    await ops.client.patch(`/admin/v1/incidents/${opened.id}`, { severity: 'sev3' });
    const calmer = await feed();
    expect(
      calmer.json().data.incidents.find((i: { id: string }) => i.id === opened.id).impact
    ).toBe('minor');

    // The dashboard serves the same feed to signed-in merchants only.
    const dash = await merchant.owner.client.get('/merchant/v1/status');
    expect(dash.statusCode).toBe(200);
    expect(dash.json().data.incidents.map((i: { id: string }) => i.id)).toContain(opened.id);
    expect((await ctx.app.inject({ method: 'GET', url: '/merchant/v1/status' })).statusCode).toBe(
      401
    );

    // Retracting takes it off the feed.
    await ops.client.patch(`/admin/v1/incidents/${opened.id}`, { public: false });
    expect((await feed()).json().data.incidents.map((i: { id: string }) => i.id)).not.toContain(
      opened.id
    );
  });

  it('shows a resolved public incident for 14 days, then drops it', async () => {
    const ops = await staffSession(ctx, 'operations');
    const opened = (
      await ops.client.post('/admin/v1/incidents', {
        title: 'Brief outage',
        severity: 'sev4',
        impact: 'x',
        affectedServices: ['dashboard'],
      })
    ).json().data;
    ctx.clock.advanceBy(1000);
    await ops.client.post(`/admin/v1/incidents/${opened.id}/updates`, {
      body: 'Dashboard is slow',
      public: true,
    });
    ctx.clock.advanceBy(1000);
    await ops.client.post(`/admin/v1/incidents/${opened.id}/resolve`, {
      body: 'Dashboard is fast again',
    });
    const shown = (await feed())
      .json()
      .data.incidents.find((i: { id: string }) => i.id === opened.id);
    expect(shown).toMatchObject({
      status: 'resolved',
      headline: 'Dashboard is fast again',
      components: ['Dashboard'],
    });
    expect(shown.updates.map((u: { body: string }) => u.body)).toEqual([
      'Dashboard is slow',
      'Dashboard is fast again',
    ]);
    ctx.clock.advanceBy(15 * 24 * 3_600_000);
    expect((await feed()).json().data.incidents.map((i: { id: string }) => i.id)).not.toContain(
      opened.id
    );
  });
});

describe('postmortems', () => {
  it('is written freely, published only for a resolved incident, and final once published', async () => {
    const ops = await staffSession(ctx, 'operations');
    const incident = (
      await ops.client.post('/admin/v1/incidents', {
        title: 'Queue stall',
        severity: 'sev3',
        impact: 'Backlog',
        affectedServices: ['queues'],
      })
    ).json().data;
    const draft = {
      summary: 'The outbox queue stalled for 40 minutes.',
      rootCause: 'A poison row blocked the dispatcher.',
      timeline: [{ at: '2025-03-01T10:00:00Z', event: 'Alert fired' }],
      actionItems: [{ title: 'Quarantine poison rows', owner: 'ops', due: '2025-03-15' }],
    };
    const saved = await ops.client.post(`/admin/v1/incidents/${incident.id}/postmortem`, draft);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.postmortem).toMatchObject({
      summary: draft.summary,
      publishedAt: null,
    });
    const early = await ops.client.post(`/admin/v1/incidents/${incident.id}/postmortem`, {
      ...draft,
      publish: true,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.details.reason).toBe('publish_needs_resolved');

    await ops.client.post(`/admin/v1/incidents/${incident.id}/resolve`, { body: 'Recovered' });
    const edited = await ops.client.post(`/admin/v1/incidents/${incident.id}/postmortem`, {
      ...draft,
      summary: 'Edited summary',
    });
    expect(edited.json().data.postmortem.summary).toBe('Edited summary');
    const published = await ops.client.post(`/admin/v1/incidents/${incident.id}/postmortem`, {
      ...draft,
      publish: true,
    });
    expect(published.json().data.postmortem.publishedAt).toEqual(expect.any(String));
    const locked = await ops.client.post(`/admin/v1/incidents/${incident.id}/postmortem`, draft);
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.details.reason).toBe('postmortem_published');
    await expect(
      ctx.query(
        `update core.incident_postmortems set summary = 'sneaky' where incident_id = (select id from core.incidents where ref = $1)`,
        [incident.id]
      )
    ).rejects.toThrow(/published/);
    // A postmortem is never on the public feed.
    expect((await feed()).body).not.toContain('poison row');
  });
});
