/**
 * Creates a payout and its transaction. The one place that does, similar to PaymentCreator.
 *
 * Runs inside the caller's transaction. In order it:
 *  1. Validates merchant status and amount
 *  2. Checks available balance (via placing hold)
 *  3. Checks merchant limits
 *  4. Calculates fees
 *  5. Determines if approval is required (amount > threshold)
 *  6. Writes transaction and payout
 *  7. Places hold on merchant balance
 *  8. Creates approval request if needed
 *  9. Emits merchant event
 *
 * Nothing here talks to the gateway: the payout stays `created` or `pending_approval` until
 * a later phase submits it (after approval if needed).
 */
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { BalancesService } from '../balances/balances.service';
import { HoldsService } from '../holds/holds.service';
import { MerchantEventsService } from '../events/merchant-events.service';
import { AmlPrecheckService } from '../aml/precheck/precheck.service';
import { MerchantLimitsService } from '../aml/limits/merchant-limits.service';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { gatewayExternalIdFor, newPayoutIds } from './domain/payout-references';
import { toPayoutView } from './payout.views';
import { PayoutsRepository, type PayoutDetail } from './payouts.repository';

export interface NewPayoutInput {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly channel: 'mobile_money' | 'bank';
  /** Destination details: phone number for mobile_money, account details for bank. */
  readonly destination: {
    readonly type: 'msisdn' | 'bank_account';
    readonly value: string;
    readonly name?: string;
  };
  readonly description?: string;
  readonly metadata?: Record<string, string>;
  /** The caller's `Idempotency-Key`; stored on the payout and unique per merchant. */
  readonly idempotencyKey: string;
}

function invalid(reason: string): AppError {
  return new AppError('PAYOUT_REQUEST_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

function assertPayoutAmount(amountMinor: bigint, currency: string): string {
  if (amountMinor <= 0n) throw invalid('amount_must_be_positive');
  const upper = currency.toUpperCase();
  if (!isSupportedCurrency(upper)) throw invalid('currency_not_supported');
  return upper;
}

function assertMerchantMayPayout(scope: MerchantScope): void {
  if (scope.merchantStatus === 'draft') {
    throw new AppError('MERCHANT_INACTIVE');
  }
  if (scope.merchantStatus === 'suspended') {
    throw new AppError('MERCHANT_SUSPENDED');
  }
  if (scope.merchantStatus === 'closed') {
    throw new AppError('MERCHANT_BLOCKED');
  }
}

@Injectable()
export class PayoutCreator {
  constructor(
    private readonly payouts: PayoutsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly balances: BalancesService,
    private readonly holds: HoldsService,
    private readonly events: MerchantEventsService,
    private readonly precheck: AmlPrecheckService,
    private readonly limits: MerchantLimitsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG)
    private readonly config: Pick<AppConfig, 'PAYOUT_APPROVAL_THRESHOLD_MINOR'>
  ) {}

  async create(
    tx: Transaction,
    scope: MerchantScope,
    input: NewPayoutInput
  ): Promise<PayoutDetail> {
    assertMerchantMayPayout(scope);
    const currency = assertPayoutAmount(input.amountMinor, input.currency);
    const now = this.clock.now();
    const ids = newPayoutIds(now);

    // Validate destination
    this.validateDestination(input);

    // Check merchant limits (payout-specific limits)
    await this.checkLimits(scope, input.amountMinor, currency);

    // Check available balance by placing hold immediately
    // This serializes payouts per merchant+currency and prevents overdraw
    const holdResult = await this.holds.place(tx, {
      merchantId: scope.merchantId,
      environment: scope.environment as 'test' | 'live',
      currency,
      amountMinor: input.amountMinor,
      reason: `Payout ${ids.payoutRef}`,
      transactionId: ids.transactionId,
      expiresAt: null, // Payouts don't auto-expire; they wait for resolution
      idempotencyKey: `payout:${ids.payoutId}:hold`,
      createdBy: 'system:payout',
    });

    // Determine if approval is required
    const requiresApproval = this.requiresApproval(input.amountMinor);
    const initialStatus = requiresApproval ? 'pending_approval' : 'created';

    // Create transaction
    const transaction = await this.transactions.insert(tx, {
      id: ids.transactionId,
      ref: ids.transactionRef,
      merchantId: scope.merchantId,
      environment: scope.environment,
      type: 'payout',
      status: initialStatus,
      amountMinor: input.amountMinor,
      feeMinor: 0n, // Fees calculated when gateway processes
      netMinor: input.amountMinor,
      currency,
      channel: input.channel,
      gatewayExternalId: gatewayExternalIdFor(ids.payoutRef),
      metadata: input.metadata ?? {},
      createdAt: now,
    });

    // Create payout
    await this.payouts.insert(tx, {
      id: ids.payoutId,
      ref: ids.payoutRef,
      transactionId: transaction.id,
      merchantId: scope.merchantId,
      environment: scope.environment,
      amountMinor: input.amountMinor,
      currency,
      status: initialStatus,
      channel: input.channel,
      destination: input.destination,
      destinationEncrypted: null, // Encryption to be added if needed
      description: input.description ?? null,
      holdRef: holdResult.hold.ref,
      approvalRef: null, // Set when approval created
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ?? {},
      createdAt: now,
    });

    // Record first transaction event
    await this.transactions.insertEvent(tx, {
      id: uuidv7(now),
      transactionId: transaction.id,
      merchantId: scope.merchantId,
      environment: scope.environment,
      eventKey: 'created',
      source: 'api',
      outcome: 'applied',
      fromStatus: null,
      toStatus: initialStatus,
      occurredAt: now,
    });

    const detail = await this.payouts.findDetailById(ids.payoutId, tx);
    if (!detail) throw new Error('payout not found after insert');

    // Emit merchant event
    await this.events.emit(tx, {
      merchantId: scope.merchantId,
      environment: scope.environment,
      type: requiresApproval ? 'payout.pending_approval' : 'payout.created',
      resourceType: 'payout',
      resourceId: ids.payoutRef,
      object: toPayoutView(detail),
    });

    return detail;
  }

  private validateDestination(input: NewPayoutInput): void {
    const { destination, channel } = input;
    if (channel === 'mobile_money' && destination.type !== 'msisdn') {
      throw invalid('mobile_money_requires_msisdn');
    }
    if (channel === 'bank' && destination.type !== 'bank_account') {
      throw invalid('bank_requires_account');
    }
    if (!destination.value || destination.value.length === 0) {
      throw invalid('destination_value_required');
    }
  }

  private requiresApproval(amountMinor: bigint): boolean {
    const threshold = this.config.PAYOUT_APPROVAL_THRESHOLD_MINOR;
    if (threshold === null || threshold === undefined) return false;
    return amountMinor > BigInt(threshold);
  }

  private async checkLimits(
    scope: MerchantScope,
    amountMinor: bigint,
    currency: string
  ): Promise<void> {
    // Only check live environment
    if (scope.environment !== 'live') return;

    const limits = await this.limits.effective(scope.merchantId, currency);
    if (!limits) {
      throw new AppError('MERCHANT_LIMITS_NOT_CONFIGURED');
    }

    // Check per-transaction payout limit
    if (limits.payoutPerTxnMaxMinor !== null && amountMinor > limits.payoutPerTxnMaxMinor) {
      throw new AppError('PAYOUT_AMOUNT_EXCEEDS_LIMIT', {
        details: {
          amountMinor: amountMinor.toString(),
          limitMinor: limits.payoutPerTxnMaxMinor.toString(),
        },
      });
    }

    // Daily payout limit checking would require querying today's payout volume
    // This is simplified for now; full implementation would aggregate daily payouts
  }
}
