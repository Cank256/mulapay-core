import { Module } from '@nestjs/common';
import { EmailSender } from './email-sender';
import { EMAIL_SENDER, PUSH_SENDER, SMS_SENDER } from './messaging.port';
import { PushSender } from './push-sender';
import { SmsSender } from './sms-sender';

/** Email, SMS and push senders (spec 4.4). Tests replace the tokens or point the base URLs at a fake. */
@Module({
  providers: [
    EmailSender,
    SmsSender,
    PushSender,
    { provide: EMAIL_SENDER, useExisting: EmailSender },
    { provide: SMS_SENDER, useExisting: SmsSender },
    { provide: PUSH_SENDER, useExisting: PushSender },
  ],
  exports: [EMAIL_SENDER, SMS_SENDER, PUSH_SENDER],
})
export class MessagingModule {}
