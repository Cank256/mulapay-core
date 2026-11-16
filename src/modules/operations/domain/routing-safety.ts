/**
 * Safety checks for provider and routing changes (spec 6.2, 6.14, 11). A change is unsafe when
 * it would leave a currency with no way to be routed:
 *
 *  - Disabling a provider is unsafe when some currency has enabled routing rules naming it and
 *    none naming another enabled provider.
 *  - Removing or disabling a routing rule is unsafe when it is the last enabled rule of its
 *    currency.
 *  - A rule may only name a provider that supports its currency, and (while enabled) one that
 *    is enabled.
 *
 * Unsafe changes are not refused outright: they need a second person's approval (spec 11).
 */
import { providerSupportsCurrency } from '../../../integrations/gateway/provider-capabilities';
import { PAYMENT_PROVIDERS, type PaymentProvider } from '../../payments/domain/payment-event';

export interface ProviderState {
  readonly provider: PaymentProvider;
  readonly enabled: boolean;
}
export interface RuleState {
  readonly ref: string;
  readonly currency: string;
  readonly provider: PaymentProvider;
  readonly enabled: boolean;
}

/**
 * The currencies that would lose all routing if `target` were disabled. Routing follows the
 * enabled rules (spec 6.2: no matching rule means `no_route_available`), so a currency is at
 * risk only when it has an enabled rule naming `target` and no enabled rule naming another
 * enabled provider. A currency nobody routes yet is not at risk.
 */
export function currenciesLeftUncovered(
  target: PaymentProvider,
  providers: readonly ProviderState[],
  rules: readonly RuleState[]
): string[] {
  const enabledOthers = new Set(
    providers.filter((p) => p.enabled && p.provider !== target).map((p) => p.provider)
  );
  const uncovered = new Set<string>();
  for (const rule of rules) {
    if (!rule.enabled || rule.provider !== target) continue;
    const stillRouted = rules.some(
      (r) => r.enabled && r.currency === rule.currency && enabledOthers.has(r.provider)
    );
    if (!stillRouted) uncovered.add(rule.currency);
  }
  return [...uncovered].sort();
}

/** True when `rule` is the only enabled rule of its currency. */
export function isLastEnabledRuleOfCurrency(rule: RuleState, rules: readonly RuleState[]): boolean {
  if (!rule.enabled) return false;
  return !rules.some((r) => r.ref !== rule.ref && r.enabled && r.currency === rule.currency);
}

export type RuleProblem =
  'provider_unsupported_currency' | 'provider_disabled' | 'provider_unknown';

/** Why a rule that names `provider` for `currency` cannot be saved as enabled, if it cannot. */
export function ruleProblem(
  provider: string,
  currency: string,
  providers: readonly ProviderState[],
  enabled: boolean
): RuleProblem | undefined {
  if (!(PAYMENT_PROVIDERS as readonly string[]).includes(provider)) return 'provider_unknown';
  const known = provider as PaymentProvider;
  if (!providerSupportsCurrency(known, currency)) return 'provider_unsupported_currency';
  if (enabled && providers.find((p) => p.provider === known)?.enabled !== true) {
    return 'provider_disabled';
  }
  return undefined;
}
