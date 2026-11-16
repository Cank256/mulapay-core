/**
 * Email through Resend (https://resend.com/docs/api-reference/emails/send-email) or Postmark
 * (https://postmarkapp.com/developer/api/email-api). SES is accepted by the configuration but
 * has no adapter: the channel then reports `unavailable` and deliveries fail visibly instead of
 * being dropped.
 *
 * Plain text only: templates carry no markup, so there is nothing to escape.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../common/tokens';
import { callVendor, isPermanentStatus } from './http-call';
import type { MessageSender, OutboundMessage, SendResult } from './messaging.port';

type EmailConfig = Pick<
  AppConfig,
  'EMAIL_PROVIDER' | 'EMAIL_API_KEY' | 'EMAIL_FROM' | 'EMAIL_BASE_URL' | 'NOTIFICATION_TIMEOUT_MS'
>;

@Injectable()
export class EmailSender implements MessageSender {
  constructor(@Inject(APP_CONFIG) private readonly config: EmailConfig) {}

  get configured(): boolean {
    const p = this.config.EMAIL_PROVIDER;
    return (
      (p === 'resend' || p === 'postmark') &&
      !!this.config.EMAIL_API_KEY &&
      !!this.config.EMAIL_FROM
    );
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const provider = this.config.EMAIL_PROVIDER ?? 'none';
    if (!this.configured) {
      return { kind: 'unavailable', provider, reason: 'channel_not_configured' };
    }
    return this.config.EMAIL_PROVIDER === 'resend' ? this.resend(message) : this.postmark(message);
  }

  private async resend(m: OutboundMessage): Promise<SendResult> {
    const outcome = await callVendor(
      `${this.config.EMAIL_BASE_URL ?? 'https://api.resend.com'}/emails`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.EMAIL_API_KEY}`,
          'content-type': 'application/json',
          'idempotency-key': m.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.config.EMAIL_FROM,
          to: [m.to],
          subject: m.title ?? '',
          text: m.body,
        }),
        timeoutMs: this.config.NOTIFICATION_TIMEOUT_MS,
      }
    );
    return this.interpret(
      'resend',
      outcome,
      (json) => (json as { id?: string } | null)?.id ?? null
    );
  }

  private async postmark(m: OutboundMessage): Promise<SendResult> {
    const outcome = await callVendor(
      `${this.config.EMAIL_BASE_URL ?? 'https://api.postmarkapp.com'}/email`,
      {
        method: 'POST',
        headers: {
          'x-postmark-server-token': this.config.EMAIL_API_KEY ?? '',
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          From: this.config.EMAIL_FROM,
          To: m.to,
          Subject: m.title ?? '',
          TextBody: m.body,
          MessageStream: 'outbound',
        }),
        timeoutMs: this.config.NOTIFICATION_TIMEOUT_MS,
      }
    );
    return this.interpret(
      'postmark',
      outcome,
      (json) => (json as { MessageID?: string } | null)?.MessageID ?? null
    );
  }

  private interpret(
    provider: string,
    outcome: Awaited<ReturnType<typeof callVendor>>,
    messageId: (json: unknown) => string | null
  ): SendResult {
    if (outcome.kind === 'failure') {
      return { kind: 'unavailable', provider, reason: `provider_${outcome.reason}` };
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      return { kind: 'sent', provider, providerMessageId: messageId(outcome.json) };
    }
    // 401 and 403 mean our credentials are wrong: retrying is pointless but the fault is ours,
    // so it is reported as unavailable and an operator sees it (OPERATIONS.md).
    if (outcome.status === 401 || outcome.status === 403) {
      return { kind: 'unavailable', provider, reason: 'provider_auth_failed' };
    }
    if (isPermanentStatus(outcome.status)) {
      return { kind: 'rejected', provider, reason: `provider_rejected_${outcome.status}` };
    }
    return { kind: 'unavailable', provider, reason: `provider_status_${outcome.status}` };
  }
}
