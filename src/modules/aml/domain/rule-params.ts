/**
 * The parameters of each AML rule type (spec 6.13, `aml_rules.params`), validated when a rule
 * is created or changed and again when it is loaded to run. Pure.
 *
 * Money in params is a string of minor units (`"20000000"`), never a number, so a threshold
 * cannot lose precision in JSON. Every rule names the currency it measures, because an amount
 * threshold means nothing across currencies. `statuses` says which terminal outcomes the rule
 * looks at; it defaults to successful payments, the only ones that moved money.
 */
import { z } from 'zod';
import { isSupportedCurrency } from '../../../common/money/currency-codes';

export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled', 'expired'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

const minor = z.string().regex(/^[1-9]\d{0,17}$/, 'must be a positive amount in minor units');
const currency = z.string().refine(isSupportedCurrency, 'must be a supported currency');
const windowSeconds = z
  .number()
  .int()
  .min(60)
  .max(31 * 86400);
const count = z.number().int().min(1).max(1_000_000);
const statuses = z.array(z.enum(TERMINAL_STATUSES)).min(1).default(['succeeded']);
const phonePrefix = z.string().regex(/^\+[1-9]\d{0,6}$/, 'must look like +256 or +25670');

const base = { currency, statuses };

export const velocityParams = z.discriminatedUnion('measure', [
  z.strictObject({ ...base, measure: z.literal('count'), windowSeconds, max: count }),
  z.strictObject({ ...base, measure: z.literal('value'), windowSeconds, maxMinor: minor }),
]);

export const amountThresholdParams = z.strictObject({ ...base, thresholdMinor: minor });

export const structuringParams = z.strictObject({
  ...base,
  /** The amount that triggers a report. Payments just under it are the signal. */
  thresholdMinor: minor,
  /** How far under counts as "just under", in basis points of the threshold. */
  bandBps: z.number().int().min(1).max(5000),
  windowSeconds,
  minCount: z.number().int().min(2).max(1000),
});

export const geographyParams = z.strictObject({
  ...base,
  /** Fires when the payer's number starts with any of these. */
  flaggedPrefixes: z.array(phonePrefix).max(500).default([]),
  /** When not empty, fires when the payer's number starts with none of these. */
  allowedPrefixes: z.array(phonePrefix).max(500).default([]),
});

export const newAccountParams = z.discriminatedUnion('measure', [
  z.strictObject({
    ...base,
    measure: z.literal('count'),
    accountAgeDays: z.number().int().min(1).max(365),
    windowSeconds,
    max: count,
  }),
  z.strictObject({
    ...base,
    measure: z.literal('value'),
    accountAgeDays: z.number().int().min(1).max(365),
    windowSeconds,
    maxMinor: minor,
  }),
]);

export const roundAmountParams = z.strictObject({
  ...base,
  /** An amount is round when it is a multiple of this. */
  roundUnitMinor: minor,
  /** Small round amounts (a 1,000 shilling airtime top-up) mean nothing. */
  minAmountMinor: minor,
  windowSeconds,
  minCount: count,
});

export const counterpartyReuseParams = z.strictObject({
  ...base,
  /** `merchant`: one payer paying one merchant. `platform`: one payer across merchants. */
  scope: z.enum(['merchant', 'platform']),
  windowSeconds,
  /** Payments by the payer (merchant scope) or distinct merchants it paid (platform scope). */
  minCount: z.number().int().min(2).max(1_000_000),
});

export const RULE_PARAM_SCHEMAS = {
  velocity: velocityParams,
  amount_threshold: amountThresholdParams,
  structuring: structuringParams,
  geography: geographyParams,
  new_account: newAccountParams,
  round_amount: roundAmountParams,
  counterparty_reuse: counterpartyReuseParams,
} as const;

export type RuleType = keyof typeof RULE_PARAM_SCHEMAS;
export const RULE_TYPES = Object.keys(RULE_PARAM_SCHEMAS) as RuleType[];

export type VelocityParams = z.infer<typeof velocityParams>;
export type AmountThresholdParams = z.infer<typeof amountThresholdParams>;
export type StructuringParams = z.infer<typeof structuringParams>;
export type GeographyParams = z.infer<typeof geographyParams>;
export type NewAccountParams = z.infer<typeof newAccountParams>;
export type RoundAmountParams = z.infer<typeof roundAmountParams>;
export type CounterpartyReuseParams = z.infer<typeof counterpartyReuseParams>;

export type ParsedRule =
  | { readonly type: 'velocity'; readonly params: VelocityParams }
  | { readonly type: 'amount_threshold'; readonly params: AmountThresholdParams }
  | { readonly type: 'structuring'; readonly params: StructuringParams }
  | { readonly type: 'geography'; readonly params: GeographyParams }
  | { readonly type: 'new_account'; readonly params: NewAccountParams }
  | { readonly type: 'round_amount'; readonly params: RoundAmountParams }
  | { readonly type: 'counterparty_reuse'; readonly params: CounterpartyReuseParams };

export function isRuleType(value: string): value is RuleType {
  return (RULE_TYPES as readonly string[]).includes(value);
}

export type ParamsResult =
  | { readonly ok: true; readonly rule: ParsedRule }
  | { readonly ok: false; readonly issues: string[] };

/** Validates `params` for `type`, filling defaults. Never throws. */
export function parseRuleParams(type: string, params: unknown): ParamsResult {
  if (!isRuleType(type)) return { ok: false, issues: [`unknown rule type ${type}`] };
  const result = RULE_PARAM_SCHEMAS[type].safeParse(params);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`),
    };
  }
  return { ok: true, rule: { type, params: result.data } as ParsedRule };
}
