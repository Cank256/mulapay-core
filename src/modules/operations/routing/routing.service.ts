/**
 * Provider routing selector for collections, disbursements and refunds (spec 3.4, 6.2).
 *
 * The router evaluates enabled routing rules in priority order and returns the provider
 * to use, along with reasoning for observability. Rules are filtered by currency, country,
 * channel, amount range and MSISDN prefix. Rules of equal priority are chosen by weighted
 * random selection.
 *
 * A provider is skipped when:
 *  - `provider_status.enabled` is false
 *  - `provider_status.health` is 'down'
 *  - The provider's circuit breaker is open for the operation type
 *  - The provider does not support the requested operation (e.g. MTN does not support refunds)
 *
 * When no route matches or all routes are unavailable, the caller receives
 * `no_route_available` so the merchant gets a clear error.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error';
import type { CurrencyCode } from '../../../common/money/currency-codes';
import {
  PROVIDER_CAPABILITIES,
  providerSupports,
  type ProviderOperation,
} from '../../../integrations/gateway/provider-capabilities';
import { PAYMENT_PROVIDERS, type PaymentProvider } from '../../payments/domain/payment-event';
import { OpsConfigRepository, type ProviderRow, type RuleRow } from '../ops-config.repository';
import {
  CIRCUIT_BREAKER,
  type CircuitBreakerPort,
} from './circuit-breaker/circuit-breaker.port';

export interface RoutingRequest {
  /** What the funds are for: determines which provider capability is required. */
  readonly operation: ProviderOperation;
  /** ISO 4217 three-letter code. */
  readonly currency: CurrencyCode;
  /** ISO 3166-1 alpha-2, or `*` for any. */
  readonly country?: string;
  /** Payment channel, or `*` for any. */
  readonly channel?: 'mobile_money' | 'card' | 'bank' | '*';
  /** Amount in minor units for range matching. */
  readonly amountMinor: bigint;
  /** E.164 MSISDN with + prefix for prefix matching, or null. */
  readonly msisdn?: string | null;
}

export interface RoutingResult {
  /** The provider chosen. */
  readonly provider: PaymentProvider;
  /** The rule that matched, for observability. */
  readonly ruleRef: string;
  /** Why this provider was chosen (for logs and metrics). */
  readonly reason: string;
}

interface EvaluatedRule {
  readonly rule: RuleRow;
  readonly matchReason: string;
}

@Injectable()
export class RoutingService {
  constructor(
    private readonly config: OpsConfigRepository,
    @Inject(CIRCUIT_BREAKER) private readonly circuitBreaker: CircuitBreakerPort
  ) {}

  /**
   * Select a provider for the given routing request.
   *
   * @throws AppError('PAYMENT_REQUEST_INVALID') when no enabled rule matches or all matching
   *         providers are unavailable.
   */
  async selectProvider(request: RoutingRequest): Promise<RoutingResult> {
    // Fetch provider status and enabled routing rules for this currency
    const [providers, allRules] = await Promise.all([
      this.config.listProviders(),
      this.config.listRules({ currency: request.currency }),
    ]);

    // Filter to enabled rules only and sort by priority
    const enabledRules = allRules
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    if (enabledRules.length === 0) {
      throw new AppError('PAYMENT_REQUEST_INVALID', {
        messageParams: { reason: 'no_routing_rules' },
        details: { currency: request.currency, reason: 'no_routing_rules' },
      });
    }

    // Find matching rules
    const matchedRules = this.findMatchingRules(request, enabledRules);

    if (matchedRules.length === 0) {
      throw new AppError('PAYMENT_REQUEST_INVALID', {
        messageParams: { reason: 'no_matching_rule' },
        details: {
          currency: request.currency,
          country: request.country,
          channel: request.channel,
          amountMinor: request.amountMinor.toString(),
          reason: 'no_matching_rule',
        },
      });
    }

    // Group by priority and try each priority level in order
    const byPriority = this.groupByPriority(matchedRules);
    const priorities = Array.from(byPriority.keys()).sort((a, b) => a - b);

    for (const priority of priorities) {
      const rulesAtPriority = byPriority.get(priority)!;

      // Try to select an available provider at this priority level
      const result = await this.selectFromRules(
        rulesAtPriority,
        providers,
        request.operation
      );

      if (result) {
        return result;
      }
    }

    // No available provider found
    throw new AppError('PAYMENT_REQUEST_INVALID', {
      messageParams: { reason: 'all_providers_unavailable' },
      details: {
        currency: request.currency,
        matchedRules: matchedRules.length,
        reason: 'all_providers_unavailable',
      },
    });
  }

  /**
   * Find all rules that match the request's attributes.
   */
  private findMatchingRules(
    request: RoutingRequest,
    rules: readonly RuleRow[]
  ): EvaluatedRule[] {
    const matched: EvaluatedRule[] = [];

    for (const rule of rules) {
      const matchReasons: string[] = [];

      // Currency already filtered by the query
      matchReasons.push(`currency:${request.currency}`);

      // Country match: rule's country is '*' or matches request's country
      const requestCountry = request.country ?? '*';
      if (rule.country !== '*' && rule.country !== requestCountry) {
        continue;
      }
      if (rule.country !== '*') {
        matchReasons.push(`country:${rule.country}`);
      }

      // Channel match: rule's channel is '*' or matches request's channel
      const requestChannel = request.channel ?? '*';
      if (rule.channel !== '*' && rule.channel !== requestChannel) {
        continue;
      }
      if (rule.channel !== '*') {
        matchReasons.push(`channel:${rule.channel}`);
      }

      // Amount range match
      if (rule.minAmountMinor !== null && request.amountMinor < rule.minAmountMinor) {
        continue;
      }
      if (rule.maxAmountMinor !== null && request.amountMinor > rule.maxAmountMinor) {
        continue;
      }
      if (rule.minAmountMinor !== null || rule.maxAmountMinor !== null) {
        const min = rule.minAmountMinor?.toString() ?? 'none';
        const max = rule.maxAmountMinor?.toString() ?? 'none';
        matchReasons.push(`amount:[${min},${max}]`);
      }

      // MSISDN prefix match
      if (rule.msisdnPrefix !== null) {
        if (!request.msisdn || !request.msisdn.startsWith(rule.msisdnPrefix)) {
          continue;
        }
        matchReasons.push(`msisdn:${rule.msisdnPrefix}`);
      }

      // All conditions matched
      matched.push({
        rule,
        matchReason: matchReasons.join(','),
      });
    }

    return matched;
  }

  /**
   * Group rules by priority level.
   */
  private groupByPriority(rules: readonly EvaluatedRule[]): Map<number, EvaluatedRule[]> {
    const grouped = new Map<number, EvaluatedRule[]>();

    for (const rule of rules) {
      const priority = rule.rule.priority;
      const existing = grouped.get(priority) ?? [];
      existing.push(rule);
      grouped.set(priority, existing);
    }

    return grouped;
  }

  /**
   * Select one provider from rules at the same priority level using weighted random selection.
   * Returns undefined if no provider is available.
   */
  private async selectFromRules(
    rules: readonly EvaluatedRule[],
    providers: readonly ProviderRow[],
    operation: ProviderOperation
  ): Promise<RoutingResult | undefined> {
    // Filter to available providers
    const availableCandidates = await this.filterAvailableProviders(
      rules,
      providers,
      operation
    );

    if (availableCandidates.length === 0) {
      return undefined;
    }

    // If only one candidate, use it
    if (availableCandidates.length === 1) {
      const selected = availableCandidates[0];
      if (!selected) return undefined;
      return {
        provider: selected.rule.provider as PaymentProvider,
        ruleRef: selected.rule.ref,
        reason: `matched(${selected.matchReason}),priority:${selected.rule.priority}`,
      };
    }

    // Multiple candidates: use weighted random selection
    const selected = this.weightedRandomSelect(availableCandidates);
    if (!selected) return undefined;
    return {
      provider: selected.rule.provider as PaymentProvider,
      ruleRef: selected.rule.ref,
      reason: `matched(${selected.matchReason}),priority:${selected.rule.priority},weight:${selected.rule.weight}`,
    };
  }

  /**
   * Filter rules to only those whose providers are available:
   *  - Provider is enabled
   *  - Provider health is not 'down'
   *  - Circuit breaker is not open
   *  - Provider supports the operation
   */
  private async filterAvailableProviders(
    rules: readonly EvaluatedRule[],
    providers: readonly ProviderRow[],
    operation: ProviderOperation
  ): Promise<EvaluatedRule[]> {
    const providerMap = new Map<string, ProviderRow>();
    for (const p of providers) {
      providerMap.set(p.provider, p);
    }

    const available: EvaluatedRule[] = [];

    for (const candidate of rules) {
      const providerName = candidate.rule.provider;
      const providerRow = providerMap.get(providerName);

      if (!providerRow) {
        // Provider not found in status table (should not happen)
        continue;
      }

      // Check if provider is enabled
      if (!providerRow.enabled) {
        continue;
      }

      // Check if provider health is down
      if (providerRow.health === 'down') {
        continue;
      }

      // Check if provider supports the operation
      if (!providerSupports(providerName as PaymentProvider, operation)) {
        continue;
      }

      // Check circuit breaker
      const breakerOpen = await this.circuitBreaker.isOpen(
        providerName as PaymentProvider,
        operation
      );
      if (breakerOpen) {
        continue;
      }

      // Provider is available
      available.push(candidate);
    }

    return available;
  }

  /**
   * Weighted random selection: choose one rule based on its weight relative to the total.
   * Weights are positive integers (enforced by database constraint).
   */
  private weightedRandomSelect(rules: readonly EvaluatedRule[]): EvaluatedRule {
    const totalWeight = rules.reduce((sum, r) => sum + r.rule.weight, 0);

    // Generate random number in [0, totalWeight)
    const random = Math.random() * totalWeight;

    let accumulated = 0;
    for (const rule of rules) {
      accumulated += rule.rule.weight;
      if (random < accumulated) {
        return rule;
      }
    }

    // Fallback to last rule (should not happen due to math, but ensures we always return)
    return rules[rules.length - 1]!;
  }
}
