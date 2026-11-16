/**
 * An in-process stand-in for the email, SMS and push vendors, so the real senders run over HTTP.
 * It speaks the parts of Resend, Postmark, Africa's Talking and FCM that core uses, records every
 * request (headers included, so a test can assert an idempotency key was sent), and can be told to
 * fail a channel: `fail('email', 3, 503)` makes the next three email calls answer 503.
 */
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MessagingChannel = 'email' | 'sms' | 'push';

export interface MessagingRequest {
  readonly channel: MessagingChannel | 'token';
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface FakeMessaging {
  readonly baseUrl: string;
  readonly requests: MessagingRequest[];
  /** The service-account JSON for `FCM_CREDENTIALS_JSON`, pointing its token URI here. */
  readonly fcmCredentials: string;
  /** The next `times` calls on the channel answer `status` (and `body`, for a vendor-specific refusal). */
  fail(channel: MessagingChannel, times: number, status: number, body?: unknown): void;
  /** Every call on the channel answers 200 but the vendor refuses the recipient (SMS statusCode). */
  reset(): void;
  requestsOf(channel: MessagingChannel): MessagingRequest[];
  config(overrides?: Record<string, string>): Record<string, string>;
  close(): Promise<void>;
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startFakeMessaging(): Promise<FakeMessaging> {
  const requests: MessagingRequest[] = [];
  const failures = new Map<MessagingChannel, Array<{ status: number; body?: unknown }>>();
  let counter = 0;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await read(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const channel = ((): MessagingRequest['channel'] | undefined => {
        if (url.pathname === '/emails' || url.pathname === '/email') return 'email';
        if (url.pathname === '/version1/messaging') return 'sms';
        if (url.pathname.endsWith(':send')) return 'push';
        if (url.pathname === '/token') return 'token';
        return undefined;
      })();
      if (!channel) {
        res.writeHead(404).end();
        return;
      }
      requests.push({ channel, path: url.pathname, headers: req.headers, body });
      const send = (status: number, payload: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      if (channel === 'token') {
        send(200, { access_token: 'fake-fcm-token', expires_in: 3600 });
        return;
      }
      const queued = failures.get(channel)?.shift();
      if (queued) {
        send(queued.status, queued.body ?? { error: 'forced failure' });
        return;
      }
      counter += 1;
      if (url.pathname === '/emails') send(200, { id: `resend-${counter}` });
      else if (url.pathname === '/email')
        send(200, { MessageID: `postmark-${counter}`, ErrorCode: 0 });
      else if (channel === 'sms') {
        send(201, {
          SMSMessageData: { Recipients: [{ statusCode: 101, messageId: `at-${counter}` }] },
        });
      } else send(200, { name: `projects/test/messages/${counter}` });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fcmCredentials = JSON.stringify({
    client_email: 'core@test.iam.example',
    private_key: pem,
    token_uri: `${baseUrl}/token`,
  });

  return {
    baseUrl,
    requests,
    fcmCredentials,
    fail(channel, times, status, body) {
      const list = failures.get(channel) ?? [];
      for (let i = 0; i < times; i++) list.push({ status, body });
      failures.set(channel, list);
    },
    reset() {
      failures.clear();
      requests.length = 0;
    },
    requestsOf: (channel) => requests.filter((r) => r.channel === channel),
    config(overrides = {}) {
      return {
        EMAIL_PROVIDER: 'resend',
        EMAIL_API_KEY: 'test-email-key',
        EMAIL_FROM: 'MulaPay <no-reply@mulapay.test>',
        EMAIL_BASE_URL: baseUrl,
        SMS_PROVIDER: 'africastalking',
        SMS_API_KEY: 'test-sms-key',
        SMS_USERNAME: 'sandbox',
        SMS_SENDER_ID: 'MulaPay',
        SMS_BASE_URL: baseUrl,
        FCM_PROJECT_ID: 'mulapay-test',
        FCM_CREDENTIALS_JSON: fcmCredentials,
        FCM_BASE_URL: baseUrl,
        NOTIFICATION_RETRY_BASE_SECONDS: '1',
        ...overrides,
      };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
