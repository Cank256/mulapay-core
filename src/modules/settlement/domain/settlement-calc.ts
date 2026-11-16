/**
 * The settlement payable (spec 6.9). Pure, `bigint` minor units only: no float, no rounding
 * other than the one stated below.
 *
 *   settlement payable = gross successful payments
 *                        - refunds - fees - rolling reserve withheld
 *                        - dispute holds - AML holds
 *                        (+ earlier reserve released into this batch)
 *
 * Two limits keep the result honest against the ledger, which is the source of truth:
 *
 *  - the reserve withheld and the amount drawn from the merchant payable account together
 *    never exceed what is available there (payable minus active holds), so the posting
 *    cannot overdraw it. Earnings the account could not cover are reported as `shortfall`
 *    and stay in the payable balance for a later cycle;
 *  - a negative flow (more refunds than receipts) pays nothing from payable.
 *
 * Rolling reserve is `floor(gross * percentBps / 10_000)`: the merchant keeps the fraction
 * of a minor unit. A result below the cycle's minimum rolls over: no batch, no payout.
 */
const BPS = 10_000n;

export interface SettlementInputs {
  readonly grossMinor: bigint;
  readonly refundMinor: bigint;
  readonly feeMinor: bigint;
  /** Rolling reserve rate in basis points, 0 to 10_000. */
  readonly reserveBps: number;
  /** Reserve from earlier batches whose hold period has ended. */
  readonly reserveDueMinor: bigint;
  readonly disputeHoldMinor: bigint;
  readonly amlHoldMinor: bigint;
  /** Merchant payable balance minus active holds, as the balances module reports it. */
  readonly availablePayableMinor: bigint;
  readonly minPayoutMinor: bigint;
}

export interface SettlementAmounts {
  readonly grossMinor: bigint;
  readonly refundMinor: bigint;
  readonly feeMinor: bigint;
  readonly reserveMinor: bigint;
  readonly reserveReleaseMinor: bigint;
  readonly disputeHoldMinor: bigint;
  readonly amlHoldMinor: bigint;
  readonly shortfallMinor: bigint;
  /** Drawn from the payable account and paid out. */
  readonly payableDrawMinor: bigint;
  /** What the payout sends: `payableDrawMinor + reserveReleaseMinor`. */
  readonly netMinor: bigint;
}

export type SettlementDecision =
  | { readonly kind: 'settle'; readonly amounts: SettlementAmounts }
  /** Below the minimum: rolls into the next cycle, no batch is created. */
  | { readonly kind: 'roll_over'; readonly amounts: SettlementAmounts }
  | { readonly kind: 'nothing'; readonly amounts: SettlementAmounts };

function nonNegative(name: string, value: bigint): void {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new RangeError(`settlement input ${name} must be a non-negative bigint`);
  }
}

/** Reserve withheld from gross: `floor(gross * bps / 10_000)`. */
export function reserveWithheld(grossMinor: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError('reserve rate must be an integer between 0 and 10000 basis points');
  }
  return (grossMinor * BigInt(bps)) / BPS;
}

/**
 * Calculates one merchant's settlement for one period. Upholds: the payout never exceeds the
 * merchant's available payable plus the reserve released into it, and is never below the
 * cycle minimum (otherwise the decision is `roll_over`).
 */
export function computeSettlement(input: SettlementInputs): SettlementDecision {
  nonNegative('grossMinor', input.grossMinor);
  nonNegative('refundMinor', input.refundMinor);
  nonNegative('feeMinor', input.feeMinor);
  nonNegative('reserveDueMinor', input.reserveDueMinor);
  nonNegative('disputeHoldMinor', input.disputeHoldMinor);
  nonNegative('amlHoldMinor', input.amlHoldMinor);
  nonNegative('minPayoutMinor', input.minPayoutMinor);

  const available = input.availablePayableMinor > 0n ? input.availablePayableMinor : 0n;
  const wanted = reserveWithheld(input.grossMinor, input.reserveBps);
  const reserveMinor = wanted < available ? wanted : available;

  const flow =
    input.grossMinor -
    input.refundMinor -
    input.feeMinor -
    reserveMinor -
    input.disputeHoldMinor -
    input.amlHoldMinor;
  const room = available - reserveMinor;
  const earned = flow > 0n ? flow : 0n;
  const payableDrawMinor = earned < room ? earned : room;

  const amounts: SettlementAmounts = {
    grossMinor: input.grossMinor,
    refundMinor: input.refundMinor,
    feeMinor: input.feeMinor,
    reserveMinor,
    reserveReleaseMinor: input.reserveDueMinor,
    disputeHoldMinor: input.disputeHoldMinor,
    amlHoldMinor: input.amlHoldMinor,
    shortfallMinor: earned - payableDrawMinor,
    payableDrawMinor,
    netMinor: payableDrawMinor + input.reserveDueMinor,
  };
  if (amounts.netMinor === 0n) return { kind: 'nothing', amounts };
  if (amounts.netMinor < input.minPayoutMinor) return { kind: 'roll_over', amounts };
  return { kind: 'settle', amounts };
}
