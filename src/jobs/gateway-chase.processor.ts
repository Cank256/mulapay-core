/**
 * The `gateway-chase` queue (spec 8.9, concurrency 8): polls for stuck transactions in
 * `processing` state and queries the gateway for their status. Applies the result
 * idempotently through the appropriate lifecycle service, so every chase resolution
 * goes through the state machine, posts to the ledger, releases holds and emits merchant
 * events exactly as a gateway event delivery would.
 *
 * Job:
 *   gateway.chase   - sweep all stuck transactions and reconcile their state
 *
 * A transaction is "stuck" when:
 *   - status = 'processing' AND (outcome_unknown = true OR processing for > threshold)
 *   - has gateway_external_id (was submitted to provider)
 *   - completed_at IS NULL
 *
 * For each stuck transaction, query gateway.findByExternalId():
 *   - Found + terminal: apply the event via the lifecycle service
 *   - Found + pending: log; flag for reconciliation if stuck > 30 min
 *   - Not found: flag for reconciliation if stuck > 30 min
 *   - Gateway unavailable: skip; will retry next sweep
 *
 * The sweep is idempotent: a retry or duplicate job has the same effect. The lifecycle
 * service's event-key deduplication prevents double-posting.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../common/tokens';
import type { AppConfig } from '../config/configuration';
import type { Clock } from '../common/clock/clock';
import type { Executor } from '../common/db/database.types';
import { DB_RW } from '../common/db/tokens';
import { UnitOfWork } from '../common/db/unit-of-work';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { transactions } from '../db/schema';
import {
  type GatewayOperationsPort,
  type GatewayOperationType,
  type GatewayStatus,
} from '../integrations/gateway/gateway-operations.port';
import { GATEWAY_OPERATIONS_PORT } from '../integrations/gateway/tokens';
import { PaymentLifecycleService } from '../modules/payments/payment-lifecycle.service';
import { PaymentsRepository } from '../modules/payments/payments.repository';
import { PayoutLifecycleService } from '../modules/payouts/payout-lifecycle.service';
import { PayoutsRepository } from '../modules/payouts/payouts.repository';
import { RefundLifecycleService } from '../modules/refunds/refund-lifecycle.service';
import { RefundsRepository } from '../modules/refunds/refunds.repository';
import { ReconciliationExceptionRecorder } from '../modules/reconciliation/exception-recorder';
import type { TransactionRow } from '../modules/transactions/transactions.repository';
import { TransactionsRepository } from '../modules/transactions/transactions.repository';

export const CHASE_JOB = 'gateway.chase';

/** Transactions stuck for more than 5 minutes are chased. */
const DEFAULT_PENDING_THRESHOLD_MS = 5 * 60 * 1000;

/** Default: check for stuck transactions every 2 minutes. */
export const DEFAULT_CHASE_INTERVAL_MS = 2 * 60 * 1000;

/** Batch size per sweep. */
const DEFAULT_BATCH_SIZE = 50;

/** After 30 minutes stuck, flag for reconciliation. */
const RECONCILIATION_THRESHOLD_MS = 30 * 60 * 1000;

interface ChaseMetrics {
  checked: number;
  resolved: number;
  stillPending: number;
  notFound: number;
  errors: number;
}

@Injectable()
export class GatewayChaseProcessor implements QueueProcessor {
  readonly definition = QUEUES.gatewayChase;

  constructor(
    @Inject(DB_RW) private readonly db: Executor,
    @Inject(GATEWAY_OPERATIONS_PORT) private readonly gateway: GatewayOperationsPort,
    private readonly uow: UnitOfWork,
    private readonly txnRepo: TransactionsRepository,
    private readonly paymentsRepo: PaymentsRepository,
    private readonly payoutsRepo: PayoutsRepository,
    private readonly refundsRepo: RefundsRepository,
    private readonly paymentLifecycle: PaymentLifecycleService,
    private readonly payoutLifecycle: PayoutLifecycleService,
    private readonly refundLifecycle: RefundLifecycleService,
    private readonly reconciliation: ReconciliationExceptionRecorder,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async process(job: Job): Promise<ChaseMetrics> {
    if (job.name !== CHASE_JOB) {
      throw new UnrecoverableError(`unknown gateway-chase job ${job.name}`);
    }

    const metrics: ChaseMetrics = {
      checked: 0,
      resolved: 0,
      stillPending: 0,
      notFound: 0,
      errors: 0,
    };

    const now = this.clock.now();
    const thresholdDate = new Date(now.getTime() - DEFAULT_PENDING_THRESHOLD_MS);
    const reconciliationDate = new Date(now.getTime() - RECONCILIATION_THRESHOLD_MS);

    const stuck = await this.findStuckTransactions(thresholdDate, DEFAULT_BATCH_SIZE);
    if (stuck.length === 0) {
      this.logger.debug('gateway chase: no stuck transactions');
      return metrics;
    }

    this.logger.info({ count: stuck.length }, 'gateway chase: processing stuck transactions');

    for (const txn of stuck) {
      try {
        metrics.checked += 1;
        await this.chaseTransaction(txn, reconciliationDate, metrics);
      } catch (error) {
        metrics.errors += 1;
        this.logger.error(
          { transactionId: txn.id, ref: txn.ref, externalId: txn.gatewayExternalId, err: error },
          'gateway chase: error processing transaction'
        );
      }
    }

    this.logger.info(metrics, 'gateway chase: sweep complete');
    return metrics;
  }

  /**
   * Find transactions stuck in processing:
   *  - status = 'processing'
   *  - has gateway_external_id (was submitted)
   *  - (outcome_unknown = true OR initiated_at < threshold)
   *  - completed_at IS NULL
   */
  private async findStuckTransactions(
    thresholdDate: Date,
    limit: number
  ): Promise<TransactionRow[]> {
    return this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'processing'),
          sql`${transactions.gatewayExternalId} IS NOT NULL`,
          isNull(transactions.completedAt),
          or(eq(transactions.outcomeUnknown, true), lt(transactions.initiatedAt, thresholdDate))
        )
      )
      .orderBy(transactions.initiatedAt)
      .limit(limit);
  }

  private async chaseTransaction(
    txn: TransactionRow,
    reconciliationDate: Date,
    metrics: ChaseMetrics
  ): Promise<void> {
    const externalId = txn.gatewayExternalId;
    if (!externalId) {
      this.logger.warn({ transactionId: txn.id, ref: txn.ref }, 'gateway chase: no external_id');
      return;
    }

    const operationType = this.operationType(txn.type);
    if (!operationType) {
      this.logger.warn(
        { transactionId: txn.id, ref: txn.ref, type: txn.type },
        'gateway chase: unknown transaction type'
      );
      return;
    }

    const result = await this.gateway.findByExternalId(externalId, {
      operationType,
      providerId: txn.provider ?? undefined,
    });

    switch (result.kind) {
      case 'found': {
        const { status, referenceId } = result.operation;
        this.logger.info(
          { transactionId: txn.id, ref: txn.ref, externalId, status },
          'gateway chase: found operation'
        );

        if (this.isTerminal(status)) {
          await this.applyViaLifecycle(txn, status, referenceId ?? null);
          metrics.resolved += 1;
        } else {
          if (txn.initiatedAt && txn.initiatedAt < reconciliationDate) {
            await this.raiseReconciliationException(txn, 'stuck_pending', externalId);
          } else {
            this.logger.debug(
              { transactionId: txn.id, ref: txn.ref },
              'gateway chase: still pending'
            );
          }
          metrics.stillPending += 1;
        }
        break;
      }

      case 'not_found':
        this.logger.warn(
          { transactionId: txn.id, ref: txn.ref, externalId },
          'gateway chase: operation not found'
        );
        metrics.notFound += 1;
        if (txn.initiatedAt && txn.initiatedAt < reconciliationDate) {
          await this.raiseReconciliationException(txn, 'operation_not_found', externalId);
        }
        break;

      case 'unavailable':
        this.logger.warn(
          { transactionId: txn.id, ref: txn.ref, externalId, reason: result.reason },
          'gateway chase: gateway unavailable, will retry'
        );
        break;
    }
  }

  /**
   * Applies a terminal gateway status through the proper lifecycle service. The lifecycle
   * service handles the state machine, ledger posting, hold release and merchant events —
   * the chase processor must not do any of that itself.
   */
  private async applyViaLifecycle(
    txn: TransactionRow,
    status: GatewayStatus,
    referenceId: string | null
  ): Promise<void> {
    // Build a deterministic event key: chase + externalId + status (not a timestamp).
    const eventKey = `chase:${txn.gatewayExternalId}:${status}`;
    const now = this.clock.now();

    if (txn.type === 'payment') {
      const payment = await this.paymentsRepo.findByTransactionId(txn.id);
      if (!payment) {
        this.logger.warn(
          { transactionId: txn.id, ref: txn.ref },
          'gateway chase: payment row not found'
        );
        return;
      }
      await this.uow.run((tx) =>
        this.paymentLifecycle.apply(tx, payment.id, {
          eventKey,
          source: 'chase',
          occurredAt: now,
          signal: this.paymentSignal(status),
          identifiers: referenceId ? { referenceId } : undefined,
        })
      );
      return;
    }

    if (txn.type === 'payout') {
      const payout = await this.payoutsRepo.findByTransactionId(txn.id);
      if (!payout) {
        this.logger.warn(
          { transactionId: txn.id, ref: txn.ref },
          'gateway chase: payout row not found'
        );
        return;
      }
      await this.uow.run((tx) =>
        this.payoutLifecycle.apply(tx, payout.id, {
          eventKey,
          source: 'chase',
          occurredAt: now,
          signal: this.payoutSignal(status),
          gatewayDetails: referenceId ? { referenceId } : undefined,
        })
      );
      return;
    }

    if (txn.type === 'refund') {
      const refund = await this.refundsRepo.findByTransactionId(txn.id, this.db);
      if (!refund) {
        this.logger.warn(
          { transactionId: txn.id, ref: txn.ref },
          'gateway chase: refund row not found'
        );
        return;
      }
      await this.uow.run((tx) =>
        this.refundLifecycle.apply(tx, refund.id, {
          eventKey,
          source: 'chase',
          occurredAt: now,
          signal: this.refundSignal(status),
          identifiers: referenceId ? { referenceId } : undefined,
        })
      );
      return;
    }

    this.logger.warn(
      { transactionId: txn.id, type: txn.type },
      'gateway chase: no lifecycle handler for transaction type'
    );
  }

  private async raiseReconciliationException(
    txn: TransactionRow,
    reason: 'stuck_pending' | 'operation_not_found',
    externalId: string
  ): Promise<void> {
    this.logger.error(
      { transactionId: txn.id, ref: txn.ref, externalId, reason },
      'gateway chase: raising reconciliation exception'
    );
    try {
      const kind =
        reason === 'stuck_pending'
          ? 'stale_processing_transaction'
          : 'core_transaction_missing_at_gateway';
      await this.uow.run((tx) =>
        this.reconciliation.raise(tx, null, {
          kind,
          dedupeKey: `chase:${reason}:${txn.ref}`,
          environment: txn.environment as 'test' | 'live',
          currency: txn.currency,
          amountMinor: txn.amountMinor,
          merchantId: txn.merchantId,
          transactionId: txn.id,
          expected: { status: 'terminal', externalId },
          actual: { status: txn.status, reason, initiatedAt: txn.initiatedAt?.toISOString() },
        })
      );
    } catch (error) {
      this.logger.error(
        { transactionId: txn.id, err: error },
        'gateway chase: failed to raise reconciliation exception'
      );
    }
  }

  private operationType(type: string): GatewayOperationType | null {
    switch (type) {
      case 'payment':
        return 'collection';
      case 'payout':
      case 'settlement':
        return 'disbursement';
      case 'refund':
        return 'refund';
      default:
        return null;
    }
  }

  private isTerminal(status: GatewayStatus): boolean {
    return ['successful', 'failed', 'expired', 'cancelled'].includes(status);
  }

  private paymentSignal(
    status: GatewayStatus
  ): import('../modules/payments/domain/payment-event').PaymentSignal {
    switch (status) {
      case 'successful':
        return { kind: 'succeeded' };
      case 'failed':
        return { kind: 'failed', failureCode: 'gateway_failed' };
      case 'expired':
        return { kind: 'expired', failureCode: 'gateway_expired' };
      case 'cancelled':
        return { kind: 'cancelled', failureCode: 'gateway_cancelled' };
      default:
        return { kind: 'processing', outcomeUnknown: status === 'unknown' };
    }
  }

  private payoutSignal(
    status: GatewayStatus
  ): import('../modules/payouts/domain/payout-event').PayoutSignal {
    switch (status) {
      case 'successful':
        return { kind: 'succeeded' };
      case 'failed':
        return { kind: 'failed', code: 'gateway_failed' };
      case 'expired':
        return { kind: 'expired', code: 'gateway_expired' };
      case 'cancelled':
        return { kind: 'cancelled', code: 'gateway_cancelled' };
      default:
        return { kind: 'processing', outcomeUnknown: status === 'unknown' };
    }
  }

  private refundSignal(
    status: GatewayStatus
  ): import('../modules/refunds/domain/refund-state-machine').RefundEventSignal {
    switch (status) {
      case 'successful':
        return { kind: 'succeeded' };
      case 'failed':
        return { kind: 'failed', failureCode: 'gateway_failed' };
      case 'cancelled':
        return { kind: 'cancelled', failureCode: 'gateway_cancelled' };
      default:
        // Refunds don't have 'expired' in their state machine; map to failed.
        return { kind: 'failed', failureCode: 'gateway_failed' };
    }
  }
}
