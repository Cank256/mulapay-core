/**
 * Notifications (spec 6.12): templates, channel selection by preference, the five-minute
 * deduplication window, the in-app inbox, per-channel delivery with retry and failure handling,
 * and the delivery log that makes retries observable. The real email, SMS and push senders run
 * over HTTP against an in-process vendor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addTeamMember,
  loginMerchantUser,
  staffSession,
  type MerchantUser,
} from '../support/identity';
import { createTestMerchant, type TestMerchant } from '../support/payments';
import { startSupportContext, type SupportContext } from '../support/support-ops';

/** Longer than any backoff the retries here wait (30 s doubling, three attempts). */
const RETRY_WAIT_MS = 10 * 60_000;
let ctx: SupportContext;
let merchant: TestMerchant;
let viewer: MerchantUser;
let developer: MerchantUser;
let support: MerchantUser;
let ownerId: string;
let viewerId: string;
let developerId: string;

/** The internal id behind a user's public ref (`usr_...`). */
/** Tests advance the shared clock, which expires access tokens: sign in again. */
const signIn = (user: MerchantUser) => loginMerchantUser(user.client, user.email, user.merchantId);

const idOf = async (ref: string) =>
  (await ctx.query<{ id: string }>(`select id from core.users where ref = $1`, [ref]))[0]!.id;

beforeAll(async () => {
  ctx = await startSupportContext({ overrides: { NOTIFICATION_MAX_ATTEMPTS: '3' } });
  merchant = await createTestMerchant(ctx, { label: 'notify' });
  viewer = await addTeamMember(ctx, merchant.owner, 'viewer');
  developer = await addTeamMember(ctx, merchant.owner, 'developer');
  support = await addTeamMember(ctx, merchant.owner, 'support');
  [ownerId, viewerId, developerId] = await Promise.all([
    idOf(merchant.owner.userId),
    idOf(viewer.userId),
    idOf(developer.userId),
  ]);
});
afterAll(async () => {
  await ctx?.close();
});

let counter = 0;
const resource = () => `cmp_TEST${Date.now()}${counter++}`;
const notifyResolved = (resourceKey: string, sourceKey?: string) =>
  ctx.unitOfWork.run((tx) =>
    ctx.notificationsService.notify(tx, {
      templateCode: 'complaint.resolved',
      audience: { kind: 'merchant', merchantId: merchant.id, permission: 'complaints:read' },
      resourceKey,
      sourceKey,
      variables: { complaint_ref: resourceKey, subject: 'A subject' },
    })
  );
const rowsFor = (userId: string, template: string) =>
  ctx.query<{ channel: string; resource_key: string; ref: string }>(
    `select channel, resource_key, ref from core.notifications where recipient_id = $1 and template_code = $2 order by created_at`,
    [userId, template]
  );

describe('who is notified, and on which channels', () => {
  it('reaches the members whose role holds the permission, on every channel the template has', async () => {
    const key = resource();
    const result = await notifyResolved(key);
    // The owner and the viewer can read complaints; the developer cannot.
    // The owner, the viewer and the support member can read complaints, each on two channels.
    expect(result.created).toBe(6);
    const owner = (await rowsFor(ownerId, 'complaint.resolved')).filter(
      (r) => r.resource_key === key
    );
    expect(owner.map((r) => r.channel).sort()).toEqual(['email', 'in_app']);
    expect(
      (await rowsFor(viewerId, 'complaint.resolved')).some((r) => r.resource_key === key)
    ).toBe(true);
    expect(
      (await rowsFor(developerId, 'complaint.resolved')).some((r) => r.resource_key === key)
    ).toBe(false);
    const delivery = await ctx.query<{ status: string; channel: string }>(
      `select d.status, d.channel from core.notification_deliveries d join core.notifications n on n.id = d.notification_id
        where n.recipient_id = $1 and n.resource_key = $2 order by d.channel`,
      [ownerId, key]
    );
    // In-app is complete when the row exists; email waits for a worker.
    expect(delivery).toEqual([
      { status: 'pending', channel: 'email' },
      { status: 'delivered', channel: 'in_app' },
    ]);
  });

  it('respects a switched-off channel, but never for a required notification', async () => {
    const prefs = await viewer.client.patch('/merchant/v1/notification-preferences', {
      preferences: [{ template: 'complaint.resolved', channel: 'email', enabled: false }],
    });
    expect(prefs.statusCode).toBe(200);
    const key = resource();
    await notifyResolved(key);
    const rows = (await rowsFor(viewerId, 'complaint.resolved')).filter(
      (r) => r.resource_key === key
    );
    expect(rows.map((r) => r.channel)).toEqual(['in_app']);

    const locked = await viewer.client.patch('/merchant/v1/notification-preferences', {
      preferences: [{ template: 'dispute.created', channel: 'email', enabled: false }],
    });
    expect(locked.statusCode).toBe(422);
    expect(locked.json().error.code).toBe('NOTIFICATION_PREFERENCE_LOCKED');

    // A channel-wide switch-off is ignored for a required template.
    await viewer.client.patch('/merchant/v1/notification-preferences', {
      preferences: [{ template: '*', channel: 'email', enabled: false }],
    });
    const required = resource();
    await ctx.unitOfWork.run((tx) =>
      ctx.notificationsService.notify(tx, {
        templateCode: 'dispute.created',
        audience: { kind: 'user', userId: viewerId },
        resourceKey: required,
        variables: {
          dispute_ref: required,
          amount_minor: '5',
          currency: 'UGX',
          evidence_due: 'soon',
        },
      })
    );
    const got = (await rowsFor(viewerId, 'dispute.created')).filter(
      (r) => r.resource_key === required
    );
    expect(got.map((r) => r.channel).sort()).toEqual(['email', 'in_app']);
    const listed = await viewer.client.get('/merchant/v1/notification-preferences');
    expect(listed.json().data.items).toEqual(
      expect.arrayContaining([{ template: '*', channel: 'email', enabled: false }])
    );
  });

  it('skips a template that does not exist, or that cannot render, without failing the caller', async () => {
    const missing = await ctx.unitOfWork.run((tx) =>
      ctx.notificationsService.notify(tx, {
        templateCode: 'no.such.template',
        audience: { kind: 'user', userId: developerId },
        resourceKey: resource(),
      })
    );
    expect(missing).toEqual({ created: 0, deduplicated: 0 });
    const unrendered = await ctx.unitOfWork.run((tx) =>
      ctx.notificationsService.notify(tx, {
        templateCode: 'complaint.resolved',
        audience: { kind: 'user', userId: developerId },
        resourceKey: resource(),
        variables: { complaint_ref: 'x' },
      })
    );
    expect(unrendered).toEqual({ created: 0, deduplicated: 0 });
  });
});

describe('deduplication (spec 6.12)', () => {
  it('does not notify the same recipient of the same template and resource again within five minutes', async () => {
    const key = resource();
    const first = await notifyResolved(key);
    ctx.clock.advanceBy(4 * 60_000 + 59_000);
    const second = await notifyResolved(key);
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    expect(second.deduplicated).toBe(3);
    ctx.clock.advanceBy(2_000);
    const third = await notifyResolved(key);
    expect(third.created).toBe(first.created);
    // Another resource is not a duplicate.
    expect((await notifyResolved(resource())).created).toBeGreaterThan(0);
  });

  it('creates nothing twice for the same fact, however much later', async () => {
    const key = resource();
    const first = await notifyResolved(key, `fact:${key}`);
    ctx.clock.advanceBy(60 * 60_000);
    const again = await notifyResolved(key, `fact:${key}`);
    expect(first.created).toBeGreaterThan(0);
    expect(again.created).toBe(0);
  });

  it('lets one of many concurrent notifications through', async () => {
    const key = resource();
    const results = await Promise.all(Array.from({ length: 12 }, () => notifyResolved(key)));
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(
      results.find((r) => r.created > 0)?.created
    );
    const rows = (await rowsFor(ownerId, 'complaint.resolved')).filter(
      (r) => r.resource_key === key
    );
    expect(rows.filter((r) => r.channel === 'in_app')).toHaveLength(1);
  });
});

describe('the in-app inbox', () => {
  it('lists newest first, counts unread, marks one or all read, and never shows another user’s', async () => {
    const user = support;
    await signIn(user);
    await signIn(merchant.owner);
    const supportId = await idOf(user.userId);
    const baseline = (await user.client.get('/merchant/v1/notifications/unread-count')).json().data
      .unread as number;
    for (const k of [resource(), resource(), resource()]) {
      await ctx.unitOfWork.run((tx) =>
        ctx.notificationsService.notify(tx, {
          templateCode: 'complaint.resolved',
          audience: { kind: 'user', userId: supportId },
          resourceKey: k,
          variables: { complaint_ref: k, subject: 's' },
        })
      );
      ctx.clock.advanceBy(1000);
    }
    const unread = await user.client.get('/merchant/v1/notifications/unread-count');
    expect(unread.json().data.unread).toBe(baseline + 3);
    const list = await user.client.get('/merchant/v1/notifications?limit=2');
    expect(list.json().data.items).toHaveLength(2);
    expect(list.json().data.nextCursor).toEqual(expect.any(String));
    const rest = await user.client.get(
      `/merchant/v1/notifications?limit=2&cursor=${list.json().data.nextCursor}`
    );
    expect(rest.json().data.items.length).toBeGreaterThanOrEqual(1);

    const first = list.json().data.items[0];
    expect(first).toMatchObject({ read: false, template: 'complaint.resolved' });
    expect(
      (await user.client.post(`/merchant/v1/notifications/${first.id}/read`, {})).statusCode
    ).toBe(200);
    expect(
      (await user.client.get('/merchant/v1/notifications/unread-count')).json().data.unread
    ).toBe(baseline + 2);
    // Marking it again is harmless.
    expect(
      (await user.client.post(`/merchant/v1/notifications/${first.id}/read`, {})).statusCode
    ).toBe(200);

    // Someone else's notification is "not found", the same as one that does not exist.
    const theirs = await merchant.owner.client.post(
      `/merchant/v1/notifications/${first.id}/read`,
      {}
    );
    expect(theirs.statusCode).toBe(404);

    const all = await user.client.post('/merchant/v1/notifications/read-all', {});
    expect(all.json().data).toEqual({ marked: baseline + 2 });
    expect(
      (await user.client.get('/merchant/v1/notifications/unread-count')).json().data.unread
    ).toBe(0);
    const unreadOnly = await user.client.get('/merchant/v1/notifications?unread=true');
    expect(unreadOnly.json().data.items).toEqual([]);
    expect(
      (await user.client.get('/merchant/v1/notifications?limit=100')).json().data.items.length
    ).toBeGreaterThanOrEqual(3);
  });

  it('refuses a request with no session', async () => {
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: '/merchant/v1/notifications/unread-count',
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('delivery, retry and failure', () => {
  const emailDelivery = async (userId: string, key: string) => {
    const rows = await ctx.query<{
      id: string;
      created_at: string;
      ref: string;
      status: string;
      attempts: number;
      error: string | null;
    }>(
      `select d.id, d.created_at::text, d.ref, d.status, d.attempts, d.error from core.notification_deliveries d
        join core.notifications n on n.id = d.notification_id
       where n.recipient_id = $1 and n.resource_key = $2 and d.channel = 'email'`,
      [userId, key]
    );
    const row = rows[0];
    if (!row) throw new Error('no email delivery');
    return { ...row, createdAt: new Date(row.created_at) };
  };
  const notifyOwner = async (key = resource()) => {
    await ctx.unitOfWork.run((tx) =>
      ctx.notificationsService.notify(tx, {
        templateCode: 'complaint.resolved',
        audience: { kind: 'user', userId: ownerId },
        resourceKey: key,
        variables: { complaint_ref: key, subject: 's' },
      })
    );
    return key;
  };

  it('sends through the outbox and the queue, once, with the delivery ref as idempotency key', async () => {
    ctx.messaging.reset();
    const key = await notifyOwner();
    await ctx.pump();
    const d = await emailDelivery(ownerId, key);
    expect(d).toMatchObject({ status: 'sent', attempts: 1, error: null });
    // `pump` also sent whatever earlier tests left pending, so look at this delivery's own request.
    const sent = ctx.messaging
      .requestsOf('email')
      .filter((r) => r.headers['idempotency-key'] === d.ref);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({ to: [merchant.owner.email] });
    // A second pass, or a second worker, sends nothing more.
    await ctx.pump();
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('skipped');
    expect(
      ctx.messaging.requestsOf('email').filter((r) => r.headers['idempotency-key'] === d.ref)
    ).toHaveLength(1);
  });

  it('retries a vendor outage with its attempts counted, then succeeds', async () => {
    ctx.messaging.reset();
    ctx.messaging.fail('email', 2, 503);
    const key = await notifyOwner();
    await ctx.dispatcher.dispatch();
    const d = await emailDelivery(ownerId, key);
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('retry');
    let row = await emailDelivery(ownerId, key);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, error: 'provider_status_503' });
    // Not before the backoff has passed: an early attempt finds the delivery not yet due.
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('skipped');
    ctx.clock.advanceBy(RETRY_WAIT_MS);
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('retry');
    ctx.clock.advanceBy(RETRY_WAIT_MS);
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('sent');
    row = await emailDelivery(ownerId, key);
    expect(row).toMatchObject({ status: 'sent', attempts: 3, error: null });
  });

  it('fails the delivery after the last attempt, and shows it in the delivery log', async () => {
    ctx.messaging.reset();
    ctx.messaging.fail('email', 10, 500);
    const key = await notifyOwner();
    await ctx.dispatcher.dispatch();
    const d = await emailDelivery(ownerId, key);
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('retry');
    ctx.clock.advanceBy(RETRY_WAIT_MS);
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('retry');
    ctx.clock.advanceBy(RETRY_WAIT_MS);
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('failed');
    expect(await emailDelivery(ownerId, key)).toMatchObject({
      status: 'failed',
      attempts: 3,
      error: 'provider_status_500',
    });
    // A failed delivery is final: nothing sends it again.
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('skipped');
    ctx.messaging.reset();

    const ops = await staffSession(ctx, 'operations');
    const log = await ops.client.get(
      '/admin/v1/notifications/deliveries?status=failed&channel=email'
    );
    expect(log.statusCode).toBe(200);
    expect(log.json().data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: d.ref,
          status: 'failed',
          attempts: 3,
          error: 'provider_status_500',
          channel: 'email',
        }),
      ])
    );
    // Nothing in the log carries an address or a message.
    expect(JSON.stringify(log.json())).not.toContain(merchant.owner.email);
  });

  it('fails at once when the vendor refuses the recipient, and treats bad credentials as retryable', async () => {
    ctx.messaging.reset();
    ctx.messaging.fail('email', 1, 422);
    const refused = await notifyOwner();
    await ctx.dispatcher.dispatch();
    const r = await emailDelivery(ownerId, refused);
    expect(await ctx.delivery.deliver(r.id, r.createdAt)).toBe('failed');
    expect(await emailDelivery(ownerId, refused)).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'provider_rejected_422',
    });

    ctx.messaging.fail('email', 1, 401);
    const auth = await notifyOwner();
    await ctx.dispatcher.dispatch();
    const a = await emailDelivery(ownerId, auth);
    expect(await ctx.delivery.deliver(a.id, a.createdAt)).toBe('retry');
    expect(await emailDelivery(ownerId, auth)).toMatchObject({
      status: 'pending',
      error: 'provider_auth_failed',
    });
  });

  it('delivers SMS to the encrypted destination, and push through the service account', async () => {
    ctx.messaging.reset();
    const ops = await staffSession(ctx, 'operations');
    const sms = await ops.client.put('/admin/v1/notification-destinations/sms', {
      address: '+256700123456',
    });
    expect(sms.statusCode).toBe(200);
    expect(sms.json().data).toMatchObject({ channel: 'sms', hint: '3456' });
    const stored = await ctx.query<{ address_enc: string }>(
      `select address_enc from core.notification_destinations where channel = 'sms' and user_id = (select id from core.users where ref = $1)`,
      [ops.admin.userId]
    );
    expect(stored[0]?.address_enc).not.toContain('256700123456');

    await ops.client.put('/admin/v1/notification-destinations/push', {
      address: 'device-token-abcdefghijklmnop',
    });
    const admin = await staffSession(ctx, 'super_admin');
    const created = await admin.client.put('/admin/v1/notification-templates/test.page/push', {
      subject: 'Page {{who}}',
      body: '{{who}} is needed',
      variables: ['who'],
      audience: 'staff',
    });
    expect(created.statusCode).toBe(200);
    await admin.client.put('/admin/v1/notification-templates/test.page/in_app', {
      subject: 'Page {{who}}',
      body: '{{who}} is needed',
      variables: ['who'],
      audience: 'staff',
    });

    const userId = await idOf(ops.admin.userId);
    await ctx.unitOfWork.run(async (tx) => {
      await ctx.notificationsService.notify(tx, {
        templateCode: 'incident.opened',
        audience: { kind: 'user', userId },
        resourceKey: resource(),
        variables: { incident_ref: 'inc_1', severity: 'sev1', title: 'Ledger down' },
      });
      await ctx.notificationsService.notify(tx, {
        templateCode: 'test.page',
        audience: { kind: 'user', userId },
        resourceKey: resource(),
        variables: { who: 'Ops' },
      });
    });
    await ctx.pump();
    const texts = ctx.messaging.requestsOf('sms');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.body).toContain('to=%2B256700123456');
    expect(texts[0]?.headers.apikey).toBe('test-sms-key');
    const pushes = ctx.messaging.requestsOf('push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.headers.authorization).toBe('Bearer fake-fcm-token');
    expect(JSON.parse(pushes[0]?.body ?? '{}').message).toMatchObject({
      token: 'device-token-abcdefghijklmnop',
      notification: { title: 'Page Ops' },
    });
    const statuses = await ctx.query<{ channel: string; status: string }>(
      `select channel, status from core.notification_deliveries where recipient_id = $1 and channel in ('sms', 'push')`,
      [userId]
    );
    expect(statuses.sort((a, b) => a.channel.localeCompare(b.channel))).toEqual([
      { channel: 'push', status: 'sent' },
      { channel: 'sms', status: 'sent' },
    ]);
  });

  it('does not send a delivery whose claim by another worker has not lapsed', async () => {
    ctx.messaging.reset();
    const key = await notifyOwner();
    await ctx.dispatcher.dispatch();
    const d = await emailDelivery(ownerId, key);
    // What the first worker's claim leaves behind while it is talking to the vendor.
    const claimedUntil = new Date(ctx.clock.now().getTime() + 5 * 60_000);
    await ctx.query(
      `update core.notification_deliveries set attempts = 1, next_attempt_at = $3 where id = $1 and created_at = $2`,
      [d.id, d.createdAt, claimedUntil]
    );
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('skipped');
    expect(ctx.messaging.requestsOf('email')).toHaveLength(0);
    // The sweep's job after the lease has lapsed.
    ctx.clock.advanceBy(6 * 60_000);
    expect(await ctx.delivery.deliver(d.id, d.createdAt)).toBe('sent');
    expect(ctx.messaging.requestsOf('email')).toHaveLength(1);
  });

  it('lets only one of two concurrent workers send a delivery', async () => {
    ctx.messaging.reset();
    const key = await notifyOwner();
    await ctx.dispatcher.dispatch();
    const d = await emailDelivery(ownerId, key);
    const results = await Promise.all([
      ctx.delivery.deliver(d.id, d.createdAt),
      ctx.delivery.deliver(d.id, d.createdAt),
      ctx.delivery.deliver(d.id, d.createdAt),
    ]);
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(ctx.messaging.requestsOf('email')).toHaveLength(1);
  });
});

describe('templates and announcements', () => {
  it('refuses a template that uses an undeclared variable, or declares one it never uses', async () => {
    const admin = await staffSession(ctx, 'super_admin');
    const undeclared = await admin.client.put('/admin/v1/notification-templates/test.bad/email', {
      subject: 'Hi {{name}}',
      body: 'Hello {{name}} {{other}}',
      variables: ['name'],
      audience: 'any',
    });
    expect(undeclared.statusCode).toBe(422);
    expect(undeclared.json().error.code).toBe('NOTIFICATION_TEMPLATE_INVALID');
    expect(undeclared.json().error.details.undeclared).toEqual(['other']);
    const unused = await admin.client.put('/admin/v1/notification-templates/test.bad/email', {
      subject: 'Hi',
      body: 'Hello',
      variables: ['name'],
      audience: 'any',
    });
    expect(unused.statusCode).toBe(422);
  });

  it('versions a template as it is replaced, and only template managers may', async () => {
    const admin = await staffSession(ctx, 'super_admin');
    const body = (text: string) => ({ subject: 'S', body: text, variables: [], audience: 'any' });
    const v1 = await admin.client.put(
      '/admin/v1/notification-templates/test.versioned/in_app',
      body('one')
    );
    const v2 = await admin.client.put(
      '/admin/v1/notification-templates/test.versioned/in_app',
      body('two')
    );
    expect([v1.json().data.version, v2.json().data.version]).toEqual([1, 2]);
    const agent = await staffSession(ctx, 'support_agent');
    const denied = await agent.client.put(
      '/admin/v1/notification-templates/test.versioned/in_app',
      body('three')
    );
    expect(denied.statusCode).toBe(403);
    const audit = await ctx.query(
      `select 1 from core.audit_logs where action = 'notification_template.updated' and resource_id = 'test.versioned:in_app'`
    );
    expect(audit.length).toBe(1);
  });

  it('broadcasts to the owners and admins of chosen merchants, and audits it', async () => {
    const admin = await staffSession(ctx, 'super_admin');
    await ctx.query(`update core.merchants set status = 'active' where ref = $1`, [merchant.ref]);
    const res = await admin.client.post('/admin/v1/notifications/broadcast', {
      audience: 'merchants',
      merchants: [merchant.ref],
      headline: 'Scheduled maintenance',
      message: 'Saturday 02:00 UTC',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ recipients: 1 });
    await signIn(merchant.owner);
    await signIn(viewer);
    const inbox = await merchant.owner.client.get(
      '/merchant/v1/notifications?unread=true&limit=100'
    );
    expect(inbox.json().data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Scheduled maintenance', body: 'Saturday 02:00 UTC' }),
      ])
    );
    // The viewer is neither owner nor admin.
    const viewerInbox = await viewer.client.get('/merchant/v1/notifications?limit=100');
    expect(JSON.stringify(viewerInbox.json())).not.toContain('Scheduled maintenance');
  });
});

describe('notifications from merchant events', () => {
  it('tells the people whose role needs to know, for live events only', async () => {
    const emit = (environment: 'live' | 'test') =>
      ctx.unitOfWork.run((tx) =>
        ctx.events.emit(tx, {
          merchantId: merchant.id,
          environment,
          type: 'kyc.approved',
          resourceType: 'kyc',
          resourceId: `kyc-${environment}-${Date.now()}`,
          object: {},
        })
      );
    const before = await ctx.query<{ n: string }>(
      `select count(*)::text as n from core.notifications where template_code = 'kyc.approved' and recipient_id = $1`,
      [ownerId]
    );
    await emit('test');
    await emit('live');
    await ctx.pump();
    const after = await ctx.query<{ n: string }>(
      `select count(*)::text as n from core.notifications where template_code = 'kyc.approved' and recipient_id = $1`,
      [ownerId]
    );
    // One live event: an in-app and an email notification for the owner (who can submit KYC).
    expect(Number(after[0]?.n) - Number(before[0]?.n)).toBe(2);
    const viewerGot = await ctx.query(
      `select 1 from core.notifications where template_code = 'kyc.approved' and recipient_id = $1`,
      [viewerId]
    );
    expect(viewerGot).toEqual([]);
  });
});
