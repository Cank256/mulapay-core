/**
 * BullMQ processors and schedules run by the worker process (spec 4.1, 8.9). Each phase
 * registers its processors here: Phase 5 adds the outbox dispatch ticks, webhook delivery and
 * the sandbox.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { OutboxDispatcher } from '../common/outbox/outbox-dispatcher';
import { OUTBOX_HANDLERS, type OutboxHandler } from '../common/outbox/outbox-handler';
import { OutboxModule } from '../common/outbox/outbox.module';
import { QUEUE_PROCESSORS, type QueueProcessor } from '../common/queue/queue-processor';
import { DeveloperModule } from '../modules/developer/developer.module';
import { SandboxModule } from '../modules/developer/sandbox/sandbox.module';
import { SandboxPaymentHandler } from '../modules/developer/sandbox/sandbox.handler';
import { SandboxProcessor } from '../modules/developer/sandbox/sandbox.processor';
import { ReconciliationModule } from '../modules/reconciliation/reconciliation.module';
import { StatementUploadedHandler } from '../modules/reconciliation/statement-uploaded.handler';
import { SettlementModule } from '../modules/settlement/settlement.module';
import { SettlementSubmitHandler } from '../modules/settlement/settlement-submit.handler';
import { WebhookDeliveryProcessor } from '../modules/webhooks/webhook-delivery.processor';
import {
  DeliveryCreatedHandler,
  MerchantEventFanoutHandler,
} from '../modules/webhooks/webhook-fanout.handlers';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';
import { JobSchedulers } from './job-schedulers';
import { OutboxDispatchProcessor } from './outbox-dispatch.processor';
import {
  ReconciliationRunProcessor,
  StatementMatchProcessor,
} from './reconciliation-run.processor';
import { SettlementRunProcessor } from './settlement-run.processor';

@Module({
  imports: [
    DeveloperModule,
    OutboxModule,
    ReconciliationModule,
    SandboxModule,
    SettlementModule,
    WebhooksModule,
  ],
  providers: [
    OutboxDispatcher,
    OutboxDispatchProcessor,
    ReconciliationRunProcessor,
    SettlementRunProcessor,
    StatementMatchProcessor,
    {
      provide: OUTBOX_HANDLERS,
      inject: [
        MerchantEventFanoutHandler,
        DeliveryCreatedHandler,
        SandboxPaymentHandler,
        SettlementSubmitHandler,
        StatementUploadedHandler,
      ],
      useFactory: (...handlers: OutboxHandler[]) => handlers,
    },
    {
      provide: QUEUE_PROCESSORS,
      inject: [
        OutboxDispatchProcessor,
        WebhookDeliveryProcessor,
        SandboxProcessor,
        SettlementRunProcessor,
        ReconciliationRunProcessor,
        StatementMatchProcessor,
      ],
      useFactory: (...processors: QueueProcessor[]) => processors,
    },
  ],
  exports: [QUEUE_PROCESSORS, OUTBOX_HANDLERS, OutboxDispatcher],
})
export class JobsModule {
  /**
   * `schedules: false` leaves out the repeating ticks (outbox dispatch, log flush). Tests
   * that boot a worker next to other suites on a shared database use it, so the worker does
   * not act on their rows.
   */
  static register(options: { readonly schedules: boolean } = { schedules: true }): DynamicModule {
    return {
      module: JobsModule,
      providers: options.schedules ? [JobSchedulers] : [],
    };
  }
}
