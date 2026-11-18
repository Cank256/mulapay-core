/**
 * Fee calculation service (spec Phase 4, section 6.x).
 *
 * Calculates merchant fees, platform fees, and provider fees for transactions.
 * All calculations use bigint arithmetic in minor units. Fee calculation is pure and
 * idempotent: the same inputs always produce the same fee.
 *
 * Fee structure (spec 3.5, 5.5):
 * - Percentage fee (in basis points: 10000 bps = 100%)
 * - Fixed fee (in minor units)
 * - Minimum fee (enforced floor)
 * - Maximum fee (enforced ceiling, 0 = no max)
 * - Tiered pricing based on transaction amount
 *
 * Provider fees (P4-D6): Currently 0 until gateway provides them.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { ROOT_LOGGER } from '../../common/tokens';
import { AppError } from '../../common/errors/app-error';
import { MerchantPricingRepository } from './merchant-pricing.repository';

export interface FeeCalculationInput {
  operationType: 'payment' | 'payout' | 'refund';
  amountMinor: bigint;
  currency: string;
  merchantId: string;
  provider?: string | null;
  channel?: string;
}

export interface FeeBreakdown {
  /** Total fee charged to merchant (percentage + fixed, after min/max). */
  merchantFeeMinor: bigint;
  /** Platform revenue (currently equals merchant fee). */
  platformFeeMinor: bigint;
  /** Provider fee (P4-D6: always 0 until gateway provides it). */
  providerFeeMinor: bigint;
  /** Net amount after fees (amountMinor - merchantFeeMinor for payouts). */
  netMinor: bigint;
  /** Rule applied (for debugging/audit). */
  appliedRule: {
    feePlanRef: string;
    ruleId: string;
    percentBps: number;
    fixedMinor: bigint;
    minMinor: bigint;
    maxMinor: bigint;
    tierFromMinor: bigint;
  } | null;
}

/**
 * Fee calculation service. Pure functions for fee math, repository calls for rule lookup.
 */
@Injectable()
export class FeeCalculatorService {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly pricingRepo: MerchantPricingRepository
  ) {}

  /**
   * Calculate fees for a transaction.
   *
   * Returns a fee breakdown including merchant fee, platform fee (revenue), provider fee
   * (currently 0), and net amount. Fee calculation is idempotent: same inputs = same output.
   *
   * @throws AppError('FEE_PLAN_NOT_FOUND') if merchant has no fee plan
   * @throws AppError('FEE_RULE_NOT_FOUND') if no matching rule exists
   */
  async calculateFee(input: FeeCalculationInput): Promise<FeeBreakdown> {
    // Load merchant's fee plan (or default platform plan)
    const plan = await this.pricingRepo.getMerchantFeePlan(input.merchantId);
    if (!plan) {
      this.logger.error(
        { merchantId: input.merchantId },
        'Merchant has no fee plan and no default plan exists'
      );
      throw new AppError('FEE_PLAN_NOT_FOUND');
    }

    // Find matching rule (most specific first, then by priority and tier)
    const rule = await this.pricingRepo.findMatchingRule({
      feePlanId: plan.id,
      operationType: input.operationType,
      currency: input.currency,
      provider: input.provider ?? null,
      channel: input.channel ?? null,
      amountMinor: input.amountMinor,
    });

    if (!rule) {
      this.logger.warn(
        {
          merchantId: input.merchantId,
          feePlanId: plan.id,
          operationType: input.operationType,
          currency: input.currency,
          provider: input.provider,
          channel: input.channel,
          amountMinor: input.amountMinor.toString(),
        },
        'No fee rule found for transaction'
      );
      throw new AppError('FEE_RULE_NOT_FOUND');
    }

    // Calculate merchant fee using bigint arithmetic
    const merchantFeeMinor = this.computeFee(
      input.amountMinor,
      rule.percentBps,
      rule.fixedMinor,
      rule.minMinor,
      rule.maxMinor
    );

    // Platform fee = merchant fee (MulaPay keeps all merchant fees)
    const platformFeeMinor = merchantFeeMinor;

    // Provider fee (P4-D6): 0 until gateway provides it
    const providerFeeMinor = 0n;

    // Net amount depends on operation type:
    // - Payment: gross amount (merchant receives gross - fee later in settlement)
    // - Payout: amount - fee (merchant pays for payout)
    // - Refund: amount (fee already paid, not charged again)
    const netMinor = this.computeNetAmount(
      input.operationType,
      input.amountMinor,
      merchantFeeMinor
    );

    return {
      merchantFeeMinor,
      platformFeeMinor,
      providerFeeMinor,
      netMinor,
      appliedRule: {
        feePlanRef: plan.ref,
        ruleId: rule.id,
        percentBps: rule.percentBps,
        fixedMinor: rule.fixedMinor,
        minMinor: rule.minMinor,
        maxMinor: rule.maxMinor,
        tierFromMinor: rule.tierFromMinor,
      },
    };
  }

  /**
   * Calculate fee using percentage + fixed, bounded by min/max.
   *
   * Formula:
   * 1. percentFee = (amount * percentBps) / 10000  (round down)
   * 2. totalFee = percentFee + fixedMinor
   * 3. Apply min/max bounds
   *
   * All amounts are bigint minor units. No floating point.
   */
  private computeFee(
    amountMinor: bigint,
    percentBps: number,
    fixedMinor: bigint,
    minMinor: bigint,
    maxMinor: bigint
  ): bigint {
    // Calculate percentage fee: (amount * bps) / 10000, rounded down
    // Use BigInt throughout to avoid overflow
    const percentBpsBI = BigInt(percentBps);
    const percentFeeMinor = (amountMinor * percentBpsBI) / 10000n;

    // Add fixed fee
    let totalFeeMinor = percentFeeMinor + fixedMinor;

    // Apply minimum (floor)
    if (minMinor > 0n && totalFeeMinor < minMinor) {
      totalFeeMinor = minMinor;
    }

    // Apply maximum (ceiling), 0 means no max
    if (maxMinor > 0n && totalFeeMinor > maxMinor) {
      totalFeeMinor = maxMinor;
    }

    // Fee cannot exceed the transaction amount
    if (totalFeeMinor > amountMinor) {
      totalFeeMinor = amountMinor;
    }

    // Fee cannot be negative (safety check, should never happen with our constraints)
    if (totalFeeMinor < 0n) {
      totalFeeMinor = 0n;
    }

    return totalFeeMinor;
  }

  /**
   * Compute net amount after fees, operation-specific.
   *
   * - Payment: net = amount (merchant gets full amount, fee deducted at settlement)
   * - Payout: net = amount - fee (merchant pays fee upfront)
   * - Refund: net = amount (fee not charged on refunds, already paid on original payment)
   */
  private computeNetAmount(
    operationType: 'payment' | 'payout' | 'refund',
    amountMinor: bigint,
    feeMinor: bigint
  ): bigint {
    switch (operationType) {
      case 'payment':
        // Merchant receives full amount (fees deducted at settlement)
        return amountMinor;
      case 'payout':
        // Merchant pays fee: net = amount - fee
        return amountMinor - feeMinor;
      case 'refund':
        // No fee on refunds (fee already paid on original payment)
        return amountMinor;
      default:
        // TypeScript should catch this, but be safe
        throw new AppError('INVALID_OPERATION_TYPE');
    }
  }
}
