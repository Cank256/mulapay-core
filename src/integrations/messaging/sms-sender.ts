/**
 * SMS through Africa's Talking (https://developers.africastalking.com/docs/sms/sending/bulk).
 * Twilio is accepted by the configuration but has no adapter (the channel reports
 * `unavailable`, so deliveries fail visibly).
 *
 * A message is accepted when the recipient's `statusCode` is 100, 101 or 102 (processed, sent,
 * queued). Other recipient codes are the vendor refusing the number or the account.
 */
import { Inject, Injectable } from '@nestjs/common';
import { request } from 'undici';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../common/tokens';
import type { MessageSender, OutboundMessage, SendResult } from './messaging.port';

type SmsConfig = Pick<
  AppConfig,
  | 'SMS_PROVIDER'
  | 'SMS_API_KEY'
  | 'SMS_USERNAME'
  | 'SMS_SENDER_ID'
  | 'SMS_BASE_URL'
  | 'NOTIFICATION_TIMEOUT_MS'
>;

@Injectable()
export class SmsSender implements MessageSender {
  constructor(@Inject(APP_CONFIG) private readonly config: SmsConfig) {}

  get configured(): boolean {
    return (
      this.config.SMS_PROVIDER === 'africastalking' &&
      !!this.config.SMS_API_KEY &&
      !!this.config.SMS_USERNAME
    );
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const provider = this.config.SMS_PROVIDER ?? 'none';
    if (!this.configured) {
      return { kind: 'unavailable', provider, reason: 'channel_not_configured' };
    }
    const form = new URLSearchParams({
      username: this.config.SMS_USERNAME ?? '',
      to: message.to,
      message: message.body,
    });
    if (this.config.SMS_SENDER_ID) form.set('from', this.config.SMS_SENDER_ID);
    try {
      const res = await request(
        `${this.config.SMS_BASE_URL ?? 'https://api.africastalking.com'}/version1/messaging`,
        {
          method: 'POST',
          headers: {
            apikey: this.config.SMS_API_KEY ?? '',
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
          headersTimeout: this.config.NOTIFICATION_TIMEOUT_MS,
          bodyTimeout: this.config.NOTIFICATION_TIMEOUT_MS,
        }
      );
      const text = await res.body.text();
      if (res.statusCode === 401 || res.statusCode === 403) {
        return { kind: 'unavailable', provider, reason: 'provider_auth_failed' };
      }
      if (res.statusCode >= 500 || res.statusCode === 429) {
        return { kind: 'unavailable', provider, reason: `provider_status_${res.statusCode}` };
      }
      let parsed: {
        SMSMessageData?: { Recipients?: Array<{ statusCode?: number; messageId?: string }> };
      } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        return { kind: 'unavailable', provider, reason: 'provider_unreadable' };
      }
      const recipient = parsed.SMSMessageData?.Recipients?.[0];
      if (recipient?.statusCode !== undefined && [100, 101, 102].includes(recipient.statusCode)) {
        return { kind: 'sent', provider, providerMessageId: recipient.messageId ?? null };
      }
      return {
        kind: 'rejected',
        provider,
        reason: `provider_rejected_${recipient?.statusCode ?? res.statusCode}`,
      };
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      const timedOut = code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
      return {
        kind: 'unavailable',
        provider,
        reason: timedOut ? 'provider_timeout' : 'provider_network',
      };
    }
  }
}
