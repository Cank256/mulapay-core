/**
 * Decides whether one AML rule fires for one terminal transaction (spec 6.13). The rule's
 * logic is here and is pure; the numbers it compares (how many payments in the window, how
 * many just under the threshold) come from `RuleFacts`, which the monitoring service answers
 * with SQL over `aml_transaction_facts`. Tests answer it with plain values.
 *
 * Every window ends at the transaction's own completion time and includes the transaction,
 * so rerunning the job for the same transaction gives the same answer.
 *
 * Details returned with a hit carry counts, sums and thresholds only. No phone number, name or
 * hash goes into an alert.
 */
import type { ParsedRule, TerminalStatus } from './rule-params';

export interface MonitoredTransaction {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: TerminalStatus;
  readonly completedAt: Date;
  /** The payer's number in international form, when the payment had one. Memory only. */
  readonly msisdn: string | null;
  readonly counterpartyHmac: string | null;
}

export interface MerchantFacts {
  readonly createdAt: Date;
}

/** What the rules need to know about the merchant's recent history. */
export interface RuleFacts {
  /** Payments and their total in the window, in the given statuses. */
  windowTotals(
    windowSeconds: number,
    statuses: readonly TerminalStatus[]
  ): Promise<{ count: number; sumMinor: bigint }>;
  /** Payments in the window whose amount is in `[fromMinor, toMinor]`. */
  countInBand(
    windowSeconds: number,
    statuses: readonly TerminalStatus[],
    fromMinor: bigint,
    toMinor: bigint
  ): Promise<number>;
  /** Payments in the window that are a multiple of `unitMinor` and at least `minMinor`. */
  countRound(
    windowSeconds: number,
    statuses: readonly TerminalStatus[],
    unitMinor: bigint,
    minMinor: bigint
  ): Promise<number>;
  /** Payments by this payer, to this merchant or to any merchant. */
  counterpartyPayments(
    windowSeconds: number,
    statuses: readonly TerminalStatus[],
    scope: 'merchant' | 'platform'
  ): Promise<{ count: number; merchants: number }>;
}

export type Details = Record<string, string | number | boolean>;
export type Evaluation =
  | { readonly fired: false }
  | {
      readonly fired: true;
      readonly details: Details;
      /** 0..1: how far past the limit. */
      readonly excess: number;
    };

const MISS: Evaluation = { fired: false };
const DAY_MS = 86_400_000;

function ratio(observed: number | bigint, limit: number | bigint): number {
  const o = Number(observed);
  const l = Number(limit);
  return l > 0 ? Math.min(1, Math.max(0, (o - l) / l)) : 1;
}

function matchesPrefix(msisdn: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => msisdn.startsWith(p));
}

/** Evaluates `rule` for `txn`. Rules for another currency or status never fire. */
export async function evaluateRule(
  rule: ParsedRule,
  txn: MonitoredTransaction,
  merchant: MerchantFacts,
  facts: RuleFacts
): Promise<Evaluation> {
  if (rule.params.currency !== txn.currency) return MISS;
  if (!rule.params.statuses.includes(txn.status)) return MISS;
  const statuses = rule.params.statuses;

  switch (rule.type) {
    case 'velocity': {
      const p = rule.params;
      const totals = await facts.windowTotals(p.windowSeconds, statuses);
      if (p.measure === 'count') {
        if (totals.count <= p.max) return MISS;
        return {
          fired: true,
          excess: ratio(totals.count, p.max),
          details: {
            measure: 'count',
            observed: totals.count,
            max: p.max,
            windowSeconds: p.windowSeconds,
          },
        };
      }
      const max = BigInt(p.maxMinor);
      if (totals.sumMinor <= max) return MISS;
      return {
        fired: true,
        excess: ratio(totals.sumMinor, max),
        details: {
          measure: 'value',
          observedMinor: totals.sumMinor.toString(),
          maxMinor: p.maxMinor,
          windowSeconds: p.windowSeconds,
        },
      };
    }
    case 'amount_threshold': {
      const threshold = BigInt(rule.params.thresholdMinor);
      if (txn.amountMinor < threshold) return MISS;
      return {
        fired: true,
        excess: ratio(txn.amountMinor, threshold),
        details: {
          amountMinor: txn.amountMinor.toString(),
          thresholdMinor: rule.params.thresholdMinor,
        },
      };
    }
    case 'structuring': {
      const p = rule.params;
      const threshold = BigInt(p.thresholdMinor);
      const floor = threshold - (threshold * BigInt(p.bandBps)) / 10_000n;
      if (txn.amountMinor < floor || txn.amountMinor >= threshold) return MISS;
      const observed = await facts.countInBand(p.windowSeconds, statuses, floor, threshold - 1n);
      if (observed < p.minCount) return MISS;
      return {
        fired: true,
        excess: ratio(observed, p.minCount - 1),
        details: {
          observed,
          minCount: p.minCount,
          bandFloorMinor: floor.toString(),
          thresholdMinor: p.thresholdMinor,
          windowSeconds: p.windowSeconds,
        },
      };
    }
    case 'geography': {
      const p = rule.params;
      if (txn.msisdn === null) return MISS;
      const flagged = p.flaggedPrefixes.length > 0 && matchesPrefix(txn.msisdn, p.flaggedPrefixes);
      const outside = p.allowedPrefixes.length > 0 && !matchesPrefix(txn.msisdn, p.allowedPrefixes);
      if (!flagged && !outside) return MISS;
      // The prefix that matched is a calling code, not personal data.
      const prefix = flagged
        ? (p.flaggedPrefixes.find((x) => txn.msisdn?.startsWith(x)) ?? '')
        : '';
      return {
        fired: true,
        excess: 0,
        details: { reason: flagged ? 'flagged_prefix' : 'outside_allowed', prefix },
      };
    }
    case 'new_account': {
      const p = rule.params;
      const ageMs = txn.completedAt.getTime() - merchant.createdAt.getTime();
      if (ageMs >= p.accountAgeDays * DAY_MS) return MISS;
      const totals = await facts.windowTotals(p.windowSeconds, statuses);
      if (p.measure === 'count') {
        if (totals.count <= p.max) return MISS;
        return {
          fired: true,
          excess: ratio(totals.count, p.max),
          details: {
            measure: 'count',
            observed: totals.count,
            max: p.max,
            accountAgeDays: p.accountAgeDays,
          },
        };
      }
      const max = BigInt(p.maxMinor);
      if (totals.sumMinor <= max) return MISS;
      return {
        fired: true,
        excess: ratio(totals.sumMinor, max),
        details: {
          measure: 'value',
          observedMinor: totals.sumMinor.toString(),
          maxMinor: p.maxMinor,
          accountAgeDays: p.accountAgeDays,
        },
      };
    }
    case 'round_amount': {
      const p = rule.params;
      const unit = BigInt(p.roundUnitMinor);
      const min = BigInt(p.minAmountMinor);
      if (txn.amountMinor < min || txn.amountMinor % unit !== 0n) return MISS;
      const observed = await facts.countRound(p.windowSeconds, statuses, unit, min);
      if (observed < p.minCount) return MISS;
      return {
        fired: true,
        excess: ratio(observed, p.minCount - 1),
        details: {
          observed,
          minCount: p.minCount,
          roundUnitMinor: p.roundUnitMinor,
          windowSeconds: p.windowSeconds,
        },
      };
    }
    case 'counterparty_reuse': {
      const p = rule.params;
      if (txn.counterpartyHmac === null) return MISS;
      const seen = await facts.counterpartyPayments(p.windowSeconds, statuses, p.scope);
      const observed = p.scope === 'merchant' ? seen.count : seen.merchants;
      if (observed < p.minCount) return MISS;
      return {
        fired: true,
        excess: ratio(observed, p.minCount - 1),
        details: { scope: p.scope, observed, minCount: p.minCount, windowSeconds: p.windowSeconds },
      };
    }
  }
}

const SEVERITY_BASE = { low: 25, medium: 50, high: 75, critical: 90 } as const;
export type Severity = keyof typeof SEVERITY_BASE;

/** 0..100. The severity sets the floor; how far past the limit the rule went adds up to 10. */
export function alertScore(severity: Severity, excess: number): number {
  return Math.min(100, SEVERITY_BASE[severity] + Math.round(Math.min(1, Math.max(0, excess)) * 10));
}

/** True when the rule is switched on and in force at `at`. */
export function ruleIsEffective(
  rule: { enabled: boolean; effectiveFrom: Date; effectiveTo: Date | null },
  at: Date
): boolean {
  return (
    rule.enabled && rule.effectiveFrom <= at && (rule.effectiveTo === null || at < rule.effectiveTo)
  );
}
