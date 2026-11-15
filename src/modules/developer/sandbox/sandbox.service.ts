/**
 * The sandbox simulator (spec 6.11): resolves a test-environment payment the way the gateway
 * consumer will resolve a live one, through `PaymentLifecycleService.apply`, so the same
 * state machine, ledger posting, merchant events and webhook path run for both. The only
 * difference is the source: transitions are recorded with source `job` and failure codes
 * starting `sandbox_`.
 *
 * Properties:
 *  - Test only. A payment of any other environment is refused and logged; test keys never
 *    reach the gateway, and a live payment is never resolved by a simulator.
 *  - Idempotent. Every event has a deterministic key (`sandbox:{step}`), so running a step
 *    twice (a retried job) changes nothing the second time.
 *  - Each lifecycle call is its own short transaction, like the consumer's.
 *  - A terminal payment is left alone: a merchant who cancelled the payment before the
 *    simulation ran keeps the cancellation.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../../common/clock/clock';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { QUEUES } from '../../../common/queue/queue.definitions';
import { QueueRegistry } from '../../../common/queue/queue.registry';
import { CLOCK, ROOT_LOGGER, APP_CONFIG } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import type { PaymentEventInput, PaymentProvider } from '../../payments/domain/payment-event';
import {
  isTerminalPaymentStatus,
  type PaymentStatus,
} from '../../payments/domain/payment-state-machine';
import { PaymentLifecycleService } from '../../payments/payment-lifecycle.service';
import { PaymentsRepository, type PaymentDetail } from '../../payments/payments.repository';
import {
  SANDBOX_DEFAULT_PROVIDER,
  planFor,
  resolveScenario,
  type SandboxStep,
} from './domain/sandbox-scenario';

export const SANDBOX_JOB = 'sandbox.step';

export type SandboxResult = 'applied' | 'scheduled' | 'skipped' | 'refused';

export function sandboxJobId(paymentId: string, step: SandboxStep): string {
  return `sandbox_${paymentId}_${step}`;
}

@Injectable()
export class SandboxService {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly lifecycle: PaymentLifecycleService,
    private readonly unitOfWork: UnitOfWork,
    private readonly queues: QueueRegistry,
    @Inject(APP_CONFIG)
    private readonly config: Pick<
      AppConfig,
      'SANDBOX_PENDING_SECONDS' | 'SANDBOX_TIMEOUT_RESOLVE_SECONDS'
    >,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Runs one step of a payment's simulation. Safe to call twice. */
  async run(paymentId: string, step: SandboxStep): Promise<SandboxResult> {
    const detail = await this.payments.findDetailById(paymentId);
    if (!detail) return 'skipped';
    if (detail.payment.environment !== 'test') {
      this.logger.error(
        { paymentRef: detail.payment.ref, environment: detail.payment.environment },
        'sandbox refused a payment that is not in the test environment'
      );
      return 'refused';
    }
    return this.step(detail, step);
  }

  private async step(detail: PaymentDetail, step: SandboxStep): Promise<SandboxResult> {
    const { payment, transaction } = detail;
    if (isTerminalPaymentStatus(payment.status as PaymentStatus)) return 'skipped';
    const plan = planFor(
      resolveScenario({ amountMinor: payment.amountMinor, metadata: payment.metadata })
    );
    const provider = (payment.paymentMethod.provider ??
      SANDBOX_DEFAULT_PROVIDER) as PaymentProvider;
    const identifiers = { provider, referenceId: `sandbox_${payment.ref}` };
    const now = this.clock.now();
    const apply = (event: PaymentEventInput) =>
      this.unitOfWork.run((tx) => this.lifecycle.apply(tx, payment.id, event));

    if (step === 'start') {
      await apply({
        eventKey: 'sandbox:processing',
        source: 'job',
        occurredAt: now,
        signal: { kind: 'processing', outcomeUnknown: plan.outcomeUnknown },
        identifiers,
      });
      if (plan.delay !== 'none') {
        const seconds =
          plan.delay === 'pending'
            ? this.config.SANDBOX_PENDING_SECONDS
            : this.config.SANDBOX_TIMEOUT_RESOLVE_SECONDS;
        await this.queues
          .get(QUEUES.gatewayChase.name)
          .add(
            SANDBOX_JOB,
            { paymentId: payment.id, step: 'finish' },
            { delay: seconds * 1000, jobId: sandboxJobId(payment.id, 'finish') }
          );
        return 'scheduled';
      }
    }
    await apply({
      eventKey: `sandbox:${plan.terminal}`,
      source: 'job',
      occurredAt: this.clock.now(),
      signal:
        plan.terminal === 'succeeded'
          ? {
              kind: 'succeeded',
              amountMinor: transaction.amountMinor,
              currency: transaction.currency,
            }
          : plan.terminal === 'failed'
            ? { kind: 'failed', failureCode: plan.failureCode ?? 'sandbox_declined' }
            : { kind: 'expired', failureCode: plan.failureCode ?? 'sandbox_expired' },
      identifiers,
    });
    return 'applied';
  }
}
