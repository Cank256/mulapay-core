/**
 * The `gateway-chase` queue (spec 8.9, concurrency 8): polls for stuck transactions in
 * `processing` state and queries the gateway for their status. Applies the result
 * idempotently, completing transactions that were left pending due to ambiguous responses,
 * timeouts or 5xx failures during initiation.
 *
 * Job:
 *   gateway.chase   - sweep all stuck transactions and reconcile their state
 *
 * A transaction is "stuck" when:
 *   - status = 'processing' AND (outcome_unknown = true OR processing for > threshold)
 *   - has gateway_external_id (was submitted to provider)
 *   - not already terminal
 *
 * For each stuck transaction, query gateway.findByExternalId():
 *   - Found + terminal: apply the event via the appropriate lifecycle service
 *   - Found + pending: log, will be checked again next sweep
 *   - Not found: depends on how long stuck; flag for reconciliation if too long
 *   - Gateway unavailable: skip this pass, will retry next sweep
 *
 * The sweep is idempotent: a retry or duplicate job has the same effect, and applying
 * a terminal status twice is a no-op (state machine guards it).
 */
import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Logger } from 'pino';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../common/tokens';
import type { AppConfig } from '../config/configuration';
import type { Clock } from '../common/clock/clock';
import { DB_RW } from '../common/db/tokens';
import type { QueueProcessor } from '../common/queue/queue-processor';
import { QUEUES } from '../common/queue/queue.definitions';
import { transactions } from '../db/schema';
import {
  type GatewayOperationsPort,
  type GatewayOperationType,
  type GatewayStatus,
} from '../integrations/gateway/gateway-operations.port';
import { GATEWAY_OPERATIONS_PORT } from '../integrations/gateway/tokens';
import type { TransactionRow } from '../modules/transactions/transactions.repository';
import { UnitOfWork } from '../common/db/unit-of-work';

export const CHASE_JOB = 'gateway.chase';

/** Default: transactions stuck for more than 5 minutes are chased. */
const DEFAULT_PENDING_THRESHOLD_MS = 5 * 60 * 1000;

/** Default: check for stuck transactions every 2 minutes. */
export const DEFAULT_CHASE_INTERVAL_MS = 2 * 60 * 1000;

/** Batch size per sweep: process up to 50 stuck transactions per run. */
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
    @Inject(DB_RW) private readonly db: PostgresJsDatabase,
    @Inject(GATEWAY_OPERATIONS_PORT) private readonly gateway: GatewayOperationsPort,
    private readonly uow: UnitOfWork,
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

    // Find stuck transactions: processing + (outcome_unknown OR older than threshold)
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
          {
            transactionId: txn.id,
            ref: txn.ref,
            externalId: txn.gatewayExternalId,
            err: error,
          },
          'gateway chase: error processing transaction'
        );
        // Continue with next transaction; don't let one error stop the sweep
      }
    }

    this.logger.info(metrics, 'gateway chase: sweep complete');
    return metrics;
  }

  /**
   * Find transactions that are stuck in processing:
   *  - status = 'processing'
   *  - has gateway_external_id (was submitted)
   *  - (outcome_unknown = true OR initiated_at < threshold)
   *  - not completed (completed_at IS NULL)
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
          or(
            eq(transactions.outcomeUnknown, true),
            lt(transactions.initiatedAt, thresholdDate)
          )
        )
      )
      .orderBy(transactions.initiatedAt)
      .limit(limit);
  }

  /**
   * Chase one transaction: query the gateway and apply the result if terminal.
   */
  private async chaseTransaction(
    txn: TransactionRow,
    reconciliationDate: Date,
    metrics: ChaseMetrics
  ): Promise<void> {
    const externalId = txn.gatewayExternalId;
    if (!externalId) {
      this.logger.warn({ transactionId: txn.id, ref: txn.ref }, 'transaction has no external_id');
      return;
    }

    const operationType = this.mapTransactionTypeToOperationType(txn.type);
    if (!operationType) {
      this.logger.warn(
        { transactionId: txn.id, ref: txn.ref, type: txn.type },
        'unknown transaction type for chase'
      );
      return;
    }

    // Query the gateway
    const result = await this.gateway.findByExternalId(externalId, {
      operationType,
      providerId: txn.provider ?? undefined,
    });

    switch (result.kind) {
      case 'found': {
        const operation = result.operation;
        this.logger.info(
          {
            transactionId: txn.id,
            ref: txn.ref,
            externalId,
            status: operation.status,
          },
          'gateway chase: found operation'
        );

        if (this.isTerminalStatus(operation.status)) {
          // Apply the terminal status
          await this.applyStatus(txn, operation.status, operation.referenceId);
          metrics.resolved += 1;
        } else {
          // Still pending; check if it's been too long
          if (txn.initiatedAt && txn.initiatedAt < reconciliationDate) {
            this.logger.warn(
              {
                transactionId: txn.id,
                ref: txn.ref,
                externalId,
                initiatedAt: txn.initiatedAt,
              },
              'gateway chase: transaction stuck pending for too long, flagging for reconciliation'
            );
            // TODO P4: create reconciliation exception
          } else {
            this.logger.debug(
              { transactionId: txn.id, ref: txn.ref, externalId },
              'gateway chase: still pending'
            );
          }
          metrics.stillPending += 1;
        }
        break;
      }

      case 'not_found': {
        this.logger.warn(
          { transactionId: txn.id, ref: txn.ref, externalId },
          'gateway chase: operation not found'
        );
        metrics.notFound += 1;

        // If stuck for too long, flag for reconciliation
        if (txn.initiatedAt && txn.initiatedAt < reconciliationDate) {
          this.logger.error(
            {
              transactionId: txn.id,
              ref: txn.ref,
              externalId,
              initiatedAt: txn.initiatedAt,
            },
            'gateway chase: operation not found after threshold, flagging for reconciliation'
          );
          // TODO P4: create reconciliation exception
        }
        break;
      }

      case 'unavailable': {
        this.logger.warn(
          {
            transactionId: txn.id,
            ref: txn.ref,
            externalId,
            reason: result.reason,
          },
          'gateway chase: gateway unavailable'
        );
        // Skip this transaction; will be checked again next sweep
        break;
      }

      default:
        this.logger.error(
          { transactionId: txn.id, ref: txn.ref, result },
          'gateway chase: unexpected result kind'
        );
    }
  }

  /**
   * Apply a terminal status to the transaction. This updates the transaction and posts
   * ledger entries if needed, all within a transaction boundary.
   *
   * The implementation delegates to the appropriate lifecycle service based on transaction
   * type. For now, we directly update the transaction row to support the basic chase flow.
   * Phase 4's full lifecycle services will handle the complete flow.
   */
  private async applyStatus(
    txn: TransactionRow,
    status: GatewayStatus,
    referenceId: string | null
  ): Promise<void> {
    await this.uow.run(async (tx) => {
      // Lock the transaction to prevent concurrent updates
      const [locked] = await tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, txn.id), eq(transactions.createdAt, txn.createdAt)))
        .for('update');

      if (!locked) {
        this.logger.warn({ transactionId: txn.id }, 'transaction not found when applying status');
        return;
      }

      // Check if already terminal (idempotency)
      if (this.isTerminalStatus(locked.status)) {
        this.logger.debug(
          { transactionId: txn.id, status: locked.status },
          'transaction already terminal, skipping'
        );
        return;
      }

      // Update transaction status
      const newStatus = this.mapGatewayStatusToTransactionStatus(status);
      const completedAt = this.clock.now();

      await tx
        .update(transactions)
        .set({
          status: newStatus,
          gatewayReferenceId: referenceId,
          outcomeUnknown: false,
          completedAt,
        })
        .where(and(eq(transactions.id, txn.id), eq(transactions.createdAt, txn.createdAt)));

      this.logger.info(
        {
          transactionId: txn.id,
          ref: txn.ref,
          oldStatus: locked.status,
          newStatus,
        },
        'gateway chase: applied terminal status'
      );

      // TODO P4: Post ledger entries for successful collections/payouts
      // TODO P4: Release holds for failed/cancelled/expired transactions
      // TODO P4: Emit events to outbox for webhooks
    });
  }

  private mapTransactionTypeToOperationType(type: string): GatewayOperationType | null {
    switch (type) {
      case 'payment':
      case 'collection':
        return 'collection';
      case 'payout':
      case 'disbursement':
        return 'disbursement';
      case 'refund':
        return 'refund';
      default:
        return null;
    }
  }

  private isTerminalStatus(status: string): boolean {
    return ['successful', 'failed', 'expired', 'cancelled'].includes(status);
  }

  private mapGatewayStatusToTransactionStatus(status: GatewayStatus): string {
    switch (status) {
      case 'successful':
        return 'succeeded';
      case 'failed':
        return 'failed';
      case 'expired':
        return 'expired';
      case 'cancelled':
        return 'cancelled';
      case 'pending':
        return 'processing';
      case 'unknown':
        return 'processing';
      default:
        return 'processing';
    }
  }
}
