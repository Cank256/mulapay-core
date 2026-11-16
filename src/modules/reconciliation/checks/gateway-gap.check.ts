/**
 * Gateway gap reconciliation (spec 6.8 run 1). Two questions, neither of which changes
 * financial state:
 *
 *  1. Which core transactions have been `processing` longer than `RECON_STALE_MINUTES`, and
 *     what does the gateway say about each (looked up by core's own `externalId`)?
 *  2. Which operations does the gateway hold for tenant `core` that core has no transaction
 *     for? That would mean core lost a record of money movement.
 *
 * The answer to either is an exception for a person, never a status change: applying a
 * gateway outcome is the event consumer's job (or an explicit status refresh), because
 * "the gateway said so during a scan" is not the controlled path (spec 17.5).
 */
import { Inject, Injectable } from '@nestjs/common';
import { sameGatewayAmount, toGatewayAmount, toMinor } from '../../../integrations/gateway/money';
import {
  GATEWAY_OPERATIONS,
  isTerminalGatewayStatus,
  type GatewayOperation,
  type GatewayOperationType,
  type GatewayOperationsPort,
} from '../../../integrations/gateway/gateway-operations.port';
import { APP_CONFIG } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import {
  ReconciliationQueriesRepository,
  type StaleTransaction,
} from '../reconciliation-queries.repository';
import type {
  ReconciliationCheck,
  RunCheckContext,
  RunCheckResult,
} from '../reconciliation-run.service';

const DAY_MS = 86_400_000;
/** How far back gateway operations are compared with core (older ones were compared before). */
const GATEWAY_LOOKBACK_MS = DAY_MS;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;
/** Core writes its transaction before it calls the gateway; this only absorbs clock skew. */
const NEW_OPERATION_GRACE_MS = 60_000;

const OPERATION_TYPE: Readonly<Record<string, GatewayOperationType>> = {
  payment: 'collection',
  settlement: 'disbursement',
  payout: 'disbursement',
  refund: 'refund',
};

@Injectable()
export class GatewayGapCheck implements ReconciliationCheck {
  readonly kind = 'gateway_gap' as const;

  constructor(
    private readonly queries: ReconciliationQueriesRepository,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async execute(ctx: RunCheckContext): Promise<RunCheckResult> {
    if (ctx.scope.environment !== 'live') {
      return {
        checked: 0,
        matched: 0,
        summary: { skipped: 'test_environment_never_reaches_gateway' },
      };
    }
    const stale = await this.staleTransactions(ctx);
    const missing = await this.operationsMissingInCore(ctx);
    return {
      checked: stale.checked + missing.scanned,
      matched: missing.matched,
      summary: {
        staleTransactions: stale.checked,
        lookupsUnavailable: stale.unavailable,
        staleTruncated: stale.truncated,
        gatewayOperationsScanned: missing.scanned,
        gatewayOperationsMissingInCore: missing.missing,
      },
    };
  }

  private async staleTransactions(ctx: RunCheckContext) {
    const olderThan = new Date(ctx.now.getTime() - this.config.RECON_STALE_MINUTES * 60_000);
    const limit = this.config.RECON_GATEWAY_LOOKUPS_PER_RUN;
    const rows = await this.queries.staleProcessing(
      ctx.scope.environment,
      { merchantId: ctx.scope.merchantId, currency: ctx.scope.currency },
      { olderThan, since: new Date(ctx.now.getTime() - 90 * DAY_MS) },
      limit + 1
    );
    const truncated = rows.length > limit;
    let unavailable = 0;
    for (const tx of rows.slice(0, limit)) {
      if (!(await this.checkOne(ctx, tx))) unavailable += 1;
    }
    return { checked: Math.min(rows.length, limit), unavailable, truncated };
  }

  /** Returns false when the gateway could not be asked. */
  private async checkOne(ctx: RunCheckContext, tx: StaleTransaction): Promise<boolean> {
    const lookup = await this.gateway.findByExternalId(tx.externalId, {
      providerId: tx.provider ?? undefined,
      operationType: OPERATION_TYPE[tx.type],
    });
    const base = {
      environment: ctx.scope.environment,
      merchantId: tx.merchantId,
      transactionId: tx.id,
      currency: tx.currency,
      amountMinor: tx.amountMinor,
    } as const;
    const core = {
      transaction: tx.ref,
      status: 'processing',
      amountMinor: tx.amountMinor,
      currency: tx.currency,
      processingSince: tx.since,
      outcomeUnknown: tx.outcomeUnknown,
    };

    if (lookup.kind === 'not_found') {
      await ctx.raise({
        ...base,
        kind: 'core_transaction_missing_at_gateway',
        dedupeKey: `gap:missing_gateway:${tx.ref}`,
        expected: { gatewayOperation: tx.externalId },
        actual: { gateway: 'not_found', core },
      });
      return true;
    }
    if (lookup.kind === 'unavailable') {
      await ctx.raise({
        ...base,
        kind: 'stale_processing_transaction',
        dedupeKey: `gap:stale:${tx.ref}`,
        expected: { status: 'terminal' },
        actual: { gateway: 'unavailable', reason: lookup.reason, core },
      });
      return false;
    }
    const op = lookup.operation;
    if (!this.sameMoney(op, tx)) {
      await ctx.raise({
        ...base,
        kind: 'gateway_amount_mismatch',
        dedupeKey: `gap:amount:${tx.ref}`,
        gatewayOperationId: op.referenceId ?? op.externalId,
        expected: { amount: toGatewayAmount(tx.amountMinor, tx.currency), currency: tx.currency },
        actual: { amount: op.amount, currency: op.currency, gatewayStatus: op.status },
      });
      return true;
    }
    await ctx.raise({
      ...base,
      kind: isTerminalGatewayStatus(op.status)
        ? 'gateway_state_differs'
        : 'stale_processing_transaction',
      dedupeKey: isTerminalGatewayStatus(op.status) ? `gap:state:${tx.ref}` : `gap:stale:${tx.ref}`,
      gatewayOperationId: op.referenceId ?? op.externalId,
      expected: { status: 'terminal' },
      actual: { gatewayStatus: op.status, gatewayUpdatedAt: op.updatedAt, core },
    });
    return true;
  }

  private minorOrNull(op: GatewayOperation): bigint | null {
    try {
      return toMinor(op.amount, op.currency);
    } catch {
      return null;
    }
  }

  private sameMoney(op: GatewayOperation, tx: StaleTransaction): boolean {
    return (
      op.currency === tx.currency &&
      sameGatewayAmount(op.amount, toGatewayAmount(tx.amountMinor, tx.currency))
    );
  }

  private async operationsMissingInCore(ctx: RunCheckContext) {
    if (ctx.scope.merchantId) return { scanned: 0, matched: 0, missing: 0 };
    const windowStart = new Date(ctx.now.getTime() - GATEWAY_LOOKBACK_MS);
    const newest = new Date(ctx.now.getTime() - NEW_OPERATION_GRACE_MS);
    const candidates: GatewayOperation[] = [];
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const result = await this.gateway.listOperations({
        limit: LIST_PAGE_SIZE,
        offset: page * LIST_PAGE_SIZE,
      });
      if (result.kind === 'unavailable') {
        // Half a comparison is not a result: fail the run so it is retried and visible.
        throw new Error(`gateway_list_unavailable:${result.reason}`);
      }
      for (const op of result.operations) {
        if (op.createdAt >= windowStart && op.createdAt <= newest) candidates.push(op);
      }
      const oldest = result.operations.at(-1);
      if (result.operations.length < LIST_PAGE_SIZE || (oldest && oldest.createdAt < windowStart)) {
        break;
      }
    }
    const scoped = ctx.scope.currency
      ? candidates.filter((op) => op.currency === ctx.scope.currency)
      : candidates;
    const known = await this.queries.knownExternalIds(
      ctx.scope.environment,
      scoped.map((op) => op.externalId)
    );
    let missing = 0;
    for (const op of scoped) {
      if (known.has(op.externalId)) continue;
      missing += 1;
      const amountMinor = this.minorOrNull(op);
      await ctx.raise({
        kind: 'gateway_operation_missing_in_core',
        dedupeKey: `gap:missing_core:${op.operationType}:${op.externalId}`,
        environment: ctx.scope.environment,
        currency: op.currency,
        amountMinor,
        gatewayOperationId: op.referenceId ?? op.externalId,
        expected: { coreTransactionFor: op.externalId },
        actual: {
          gatewayStatus: op.status,
          operationType: op.operationType,
          provider: op.providerId,
          amount: op.amount,
          currency: op.currency,
          createdAt: op.createdAt,
        },
      });
    }
    return { scanned: scoped.length, matched: scoped.length - missing, missing };
  }
}
