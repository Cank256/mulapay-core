/**
 * Push through Firebase Cloud Messaging HTTP v1
 * (https://firebase.google.com/docs/cloud-messaging/send-message). Authentication is a service
 * account: core signs a short JWT (RS256) and exchanges it at the account's `token_uri` for an
 * access token, cached until shortly before it expires.
 *
 * An unregistered or malformed device token (404 `UNREGISTERED`, 400 `INVALID_ARGUMENT`) is a
 * rejection; the delivery fails and the destination is left for the user to replace.
 */
import { createSign } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../common/tokens';
import { callVendor } from './http-call';
import type { MessageSender, OutboundMessage, SendResult } from './messaging.port';

type PushConfig = Pick<
  AppConfig,
  'FCM_PROJECT_ID' | 'FCM_CREDENTIALS_JSON' | 'FCM_BASE_URL' | 'NOTIFICATION_TIMEOUT_MS'
>;

const credentialsSchema = z.object({
  client_email: z.string().min(3),
  private_key: z.string().min(20),
  token_uri: z.url(),
});

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

@Injectable()
export class PushSender implements MessageSender {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly credentials: z.infer<typeof credentialsSchema> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: PushConfig) {
    if (config.FCM_CREDENTIALS_JSON) {
      const parsed = credentialsSchema.safeParse(JSON.parse(config.FCM_CREDENTIALS_JSON));
      this.credentials = parsed.success ? parsed.data : undefined;
    }
  }

  get configured(): boolean {
    return !!this.config.FCM_PROJECT_ID && this.credentials !== undefined;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const provider = 'fcm';
    if (!this.configured || !this.credentials) {
      return { kind: 'unavailable', provider, reason: 'channel_not_configured' };
    }
    const token = await this.accessToken(this.credentials);
    if (token === null) return { kind: 'unavailable', provider, reason: 'provider_auth_failed' };
    const outcome = await callVendor(
      `${this.config.FCM_BASE_URL ?? 'https://fcm.googleapis.com'}/v1/projects/${encodeURIComponent(
        this.config.FCM_PROJECT_ID ?? ''
      )}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: message.to,
            notification: { title: message.title ?? '', body: message.body },
          },
        }),
        timeoutMs: this.config.NOTIFICATION_TIMEOUT_MS,
      }
    );
    if (outcome.kind === 'failure') {
      return { kind: 'unavailable', provider, reason: `provider_${outcome.reason}` };
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      const name = (outcome.json as { name?: string } | null)?.name ?? null;
      return { kind: 'sent', provider, providerMessageId: name };
    }
    if (outcome.status === 401 || outcome.status === 403) {
      this.token = undefined;
      return { kind: 'unavailable', provider, reason: 'provider_auth_failed' };
    }
    if (outcome.status === 400 || outcome.status === 404) {
      return { kind: 'rejected', provider, reason: `provider_rejected_${outcome.status}` };
    }
    return { kind: 'unavailable', provider, reason: `provider_status_${outcome.status}` };
  }

  private async accessToken(
    credentials: z.infer<typeof credentialsSchema>
  ): Promise<string | null> {
    const nowMs = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > nowMs) return this.token.value;
    const iat = Math.floor(nowMs / 1000);
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64(
      JSON.stringify({
        iss: credentials.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: credentials.token_uri,
        iat,
        exp: iat + 3600,
      })
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    let signature: string;
    try {
      signature = signer.sign(credentials.private_key).toString('base64url');
    } catch {
      return null;
    }
    const outcome = await callVendor(credentials.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }).toString(),
      timeoutMs: this.config.NOTIFICATION_TIMEOUT_MS,
    });
    if (outcome.kind !== 'response' || outcome.status !== 200) return null;
    const json = outcome.json as { access_token?: string; expires_in?: number } | null;
    if (!json?.access_token) return null;
    this.token = {
      value: json.access_token,
      expiresAt: nowMs + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }
}
