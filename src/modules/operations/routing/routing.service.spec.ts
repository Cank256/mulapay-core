/**
 * Unit tests for provider routing (spec 3.4, 6.2).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import type { ProviderRow, RuleRow } from '../ops-config.repository';
import { RoutingService } from './routing.service';
import type { CircuitBreakerPort } from './circuit-breaker/circuit-breaker.port';
import type { RoutingRequest } from './routing.service';

describe('RoutingService', () => {
  let service: RoutingService;
  let mockConfig: {
    listProviders: ReturnType<typeof vi.fn>;
    listRules: ReturnType<typeof vi.fn>;
  };
  let mockCircuitBreaker: CircuitBreakerPort;

  const baseProviders: ProviderRow[] = [
    {
      provider: 'mtn',
      enabled: true,
      health: 'healthy',
      note: null,
      successRate5m: null,
      updatedBy: null,
      updatedAt: new Date(),
    },
    {
      provider: 'airtel',
      enabled: true,
      health: 'healthy',
      note: null,
      successRate5m: null,
      updatedBy: null,
      updatedAt: new Date(),
    },
    {
      provider: 'flutterwave',
      enabled: true,
      health: 'healthy',
      note: null,
      successRate5m: null,
      updatedBy: null,
      updatedAt: new Date(),
    },
  ];

  const makeRule = (overrides: Partial<RuleRow>): RuleRow => ({
    id: overrides.id ?? 'rule-1',
    ref: overrides.ref ?? 'rrl_01',
    priority: overrides.priority ?? 100,
    currency: overrides.currency ?? 'UGX',
    country: overrides.country ?? '*',
    channel: overrides.channel ?? '*',
    minAmountMinor: overrides.minAmountMinor ?? null,
    maxAmountMinor: overrides.maxAmountMinor ?? null,
    msisdnPrefix: overrides.msisdnPrefix ?? null,
    provider: overrides.provider ?? 'mtn',
    weight: overrides.weight ?? 100,
    enabled: overrides.enabled ?? true,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    mockConfig = {
      listProviders: vi.fn(),
      listRules: vi.fn(),
    };

    mockCircuitBreaker = {
      isOpen: vi.fn().mockResolvedValue(false),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      recordAmbiguous: vi.fn().mockResolvedValue(undefined),
    };

    service = new RoutingService(mockConfig as any, mockCircuitBreaker);
  });

  describe('selectProvider', () => {
    it('selects the only matching provider', async () => {
      const rule = makeRule({ ref: 'rrl_mtn_ugx', provider: 'mtn', currency: 'UGX' });
      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([rule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);

      expect(result.provider).toBe('mtn');
      expect(result.ruleRef).toBe('rrl_mtn_ugx');
      expect(result.reason).toContain('currency:UGX');
      expect(result.reason).toContain('priority:100');
    });

    it('throws PAYMENT_REQUEST_INVALID when no rules exist', async () => {
      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      await expect(service.selectProvider(request)).rejects.toThrow('PAYMENT_REQUEST_INVALID');
    });

    it('throws NO_ROUTE_AVAILABLE when no rules match', async () => {
      const rule = makeRule({
        currency: 'UGX',
        minAmountMinor: 50000n,
        provider: 'mtn',
      });
      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([rule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n, // Below minimum
      };

      await expect(service.selectProvider(request)).rejects.toThrow('NO_ROUTE_AVAILABLE');
    });

    it('matches on country', async () => {
      const ugandaRule = makeRule({
        ref: 'rrl_ug',
        currency: 'UGX',
        country: 'UG',
        provider: 'mtn',
      });
      const wildcardRule = makeRule({
        ref: 'rrl_wild',
        currency: 'UGX',
        country: '*',
        provider: 'airtel',
        priority: 200,
      });
      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([ugandaRule, wildcardRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        country: 'UG',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('mtn');
      expect(result.reason).toContain('country:UG');
    });

    it('matches on channel', async () => {
      const mobileMoneyRule = makeRule({
        ref: 'rrl_mm',
        currency: 'UGX',
        channel: 'mobile_money',
        provider: 'mtn',
      });
      const cardRule = makeRule({
        ref: 'rrl_card',
        currency: 'UGX',
        channel: 'card',
        provider: 'flutterwave',
        priority: 200,
      });
      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([mobileMoneyRule, cardRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        channel: 'mobile_money',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('mtn');
      expect(result.reason).toContain('channel:mobile_money');
    });

    it('matches on amount range', async () => {
      const smallRule = makeRule({
        ref: 'rrl_small',
        currency: 'UGX',
        minAmountMinor: null,
        maxAmountMinor: 50000n,
        provider: 'mtn',
      });
      const largeRule = makeRule({
        ref: 'rrl_large',
        currency: 'UGX',
        minAmountMinor: 50001n,
        maxAmountMinor: null,
        provider: 'airtel',
        priority: 200,
      });
      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([smallRule, largeRule]);

      const smallRequest: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 30000n,
      };

      const smallResult = await service.selectProvider(smallRequest);
      expect(smallResult.provider).toBe('mtn');
      expect(smallResult.reason).toContain('amount:');

      const largeRequest: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 100000n,
      };

      const largeResult = await service.selectProvider(largeRequest);
      expect(largeResult.provider).toBe('airtel');
    });

    it('matches on MSISDN prefix', async () => {
      const mtnPrefixRule = makeRule({
        ref: 'rrl_mtn_prefix',
        currency: 'UGX',
        msisdnPrefix: '+25677',
        provider: 'mtn',
      });
      const airtelPrefixRule = makeRule({
        ref: 'rrl_airtel_prefix',
        currency: 'UGX',
        msisdnPrefix: '+25670',
        provider: 'airtel',
      });
      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([mtnPrefixRule, airtelPrefixRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
        msisdn: '+256770123456',
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('mtn');
      expect(result.reason).toContain('msisdn:+25677');
    });

    it('skips disabled providers', async () => {
      const mtnRule = makeRule({ ref: 'rrl_mtn', provider: 'mtn', priority: 100 });
      const airtelRule = makeRule({ ref: 'rrl_airtel', provider: 'airtel', priority: 200 });

      const providers = [...baseProviders];
      providers[0]!.enabled = false; // Disable MTN

      mockConfig.listProviders.mockResolvedValue(providers);
      mockConfig.listRules.mockResolvedValue([mtnRule, airtelRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('airtel');
    });

    it('skips providers with health down', async () => {
      const mtnRule = makeRule({ ref: 'rrl_mtn', provider: 'mtn', priority: 100 });
      const airtelRule = makeRule({ ref: 'rrl_airtel', provider: 'airtel', priority: 200 });

      const providers = [...baseProviders];
      providers[0]!.health = 'down'; // MTN is down

      mockConfig.listProviders.mockResolvedValue(providers);
      mockConfig.listRules.mockResolvedValue([mtnRule, airtelRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('airtel');
    });

    it('skips providers when circuit breaker is open', async () => {
      const mtnRule = makeRule({ ref: 'rrl_mtn', provider: 'mtn', priority: 100 });
      const airtelRule = makeRule({ ref: 'rrl_airtel', provider: 'airtel', priority: 200 });

      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([mtnRule, airtelRule]);

      // MTN's circuit breaker is open
      mockCircuitBreaker.isOpen = vi.fn().mockImplementation((provider) => {
        return Promise.resolve(provider === 'mtn');
      });

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('airtel');
      expect(mockCircuitBreaker.isOpen).toHaveBeenCalledWith('mtn', 'collection');
    });

    it('skips providers that do not support the operation', async () => {
      const mtnRule = makeRule({ ref: 'rrl_mtn', provider: 'mtn', currency: 'UGX' });
      const airtelRule = makeRule({
        ref: 'rrl_airtel',
        provider: 'airtel',
        currency: 'UGX',
        priority: 200,
      });

      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([mtnRule, airtelRule]);

      // MTN does not support refunds
      const request: RoutingRequest = {
        operation: 'refund',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('airtel');
    });

    it('throws when all providers are unavailable', async () => {
      const mtnRule = makeRule({ ref: 'rrl_mtn', provider: 'mtn' });

      const providers = [...baseProviders];
      providers[0]!.enabled = false;

      mockConfig.listProviders.mockResolvedValue(providers);
      mockConfig.listRules.mockResolvedValue([mtnRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      await expect(service.selectProvider(request)).rejects.toThrow('NO_ROUTE_AVAILABLE');
    });

    it('uses weighted random selection for equal priority rules', async () => {
      const rule1 = makeRule({
        ref: 'rrl_1',
        provider: 'mtn',
        priority: 100,
        weight: 70,
      });
      const rule2 = makeRule({
        id: 'rule-2',
        ref: 'rrl_2',
        provider: 'airtel',
        priority: 100,
        weight: 30,
      });

      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([rule1, rule2]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      // Run multiple times to test weighted selection
      const results = new Map<string, number>();
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const result = await service.selectProvider(request);
        const count = results.get(result.provider) ?? 0;
        results.set(result.provider, count + 1);
      }

      // Both providers should be selected at least once
      expect(results.has('mtn')).toBe(true);
      expect(results.has('airtel')).toBe(true);

      // MTN should be selected more often (around 70% of the time)
      // We're lenient here due to randomness
      const mtnCount = results.get('mtn') ?? 0;
      expect(mtnCount).toBeGreaterThan(iterations * 0.5); // At least 50%
    });

    it('respects priority order before weight', async () => {
      const highPriorityRule = makeRule({
        ref: 'rrl_high',
        provider: 'mtn',
        priority: 100,
        weight: 10, // Low weight
      });
      const lowPriorityRule = makeRule({
        id: 'rule-2',
        ref: 'rrl_low',
        provider: 'airtel',
        priority: 200,
        weight: 1000, // High weight
      });

      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([highPriorityRule, lowPriorityRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      // Should always select MTN due to higher priority (lower number)
      expect(result.provider).toBe('mtn');
    });

    it('falls back to lower priority when higher priority providers are unavailable', async () => {
      const highPriorityRule = makeRule({
        ref: 'rrl_high',
        provider: 'mtn',
        priority: 100,
      });
      const lowPriorityRule = makeRule({
        id: 'rule-2',
        ref: 'rrl_low',
        provider: 'airtel',
        priority: 200,
      });

      const providers = [...baseProviders];
      providers[0]!.enabled = false; // Disable MTN

      mockConfig.listProviders.mockResolvedValue(providers);
      mockConfig.listRules.mockResolvedValue([highPriorityRule, lowPriorityRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('airtel');
    });

    it('ignores disabled rules', async () => {
      const disabledRule = makeRule({
        ref: 'rrl_disabled',
        provider: 'mtn',
        priority: 100,
        enabled: false,
      });
      const enabledRule = makeRule({
        id: 'rule-2',
        ref: 'rrl_enabled',
        provider: 'airtel',
        priority: 200,
        enabled: true,
      });

      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([disabledRule, enabledRule]);

      const request: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        amountMinor: 10000n,
      };

      const result = await service.selectProvider(request);
      expect(result.provider).toBe('airtel');
    });

    it('matches complex multi-attribute rules', async () => {
      const complexRule = makeRule({
        ref: 'rrl_complex',
        currency: 'UGX',
        country: 'UG',
        channel: 'mobile_money',
        minAmountMinor: 10000n,
        maxAmountMinor: 100000n,
        msisdnPrefix: '+25677',
        provider: 'mtn',
      });
      const fallbackRule = makeRule({
        id: 'rule-2',
        ref: 'rrl_fallback',
        provider: 'airtel',
        priority: 200,
      });

      mockConfig.listProviders.mockResolvedValue(baseProviders);
      mockConfig.listRules.mockResolvedValue([complexRule, fallbackRule]);

      const matchingRequest: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        country: 'UG',
        channel: 'mobile_money',
        amountMinor: 50000n,
        msisdn: '+256770123456',
      };

      const result = await service.selectProvider(matchingRequest);
      expect(result.provider).toBe('mtn');
      expect(result.reason).toContain('country:UG');
      expect(result.reason).toContain('channel:mobile_money');
      expect(result.reason).toContain('amount:');
      expect(result.reason).toContain('msisdn:+25677');

      // Non-matching request should use fallback
      const nonMatchingRequest: RoutingRequest = {
        operation: 'collection',
        currency: 'UGX',
        country: 'KE', // Wrong country
        channel: 'mobile_money',
        amountMinor: 50000n,
        msisdn: '+256770123456',
      };

      const fallbackResult = await service.selectProvider(nonMatchingRequest);
      expect(fallbackResult.provider).toBe('airtel');
    });
  });
});
