/**
 * Provider enable and disable, health and notes, and the provider's float balance (spec 6.14,
 * 7.3). The router (Phase 4) skips a provider that is disabled or marked down (spec 6.2), so
 * taking a provider out of service is the change that can stop payments.
 *
 * Invariants upheld:
 *  - Putting a provider out of service is applied at once only when every currency routed to it
 *    still has an enabled rule naming another enabled provider (`routing-safety.ts`). Otherwise
 *    it becomes an approval request listing the currencies that would be left without a route.
 *    The check and the change run under the provider's row lock.
 *  - Re-enabling, healthy or degraded health and notes apply at once.
 *  - Every change is audited. The balance is read through the gateway port, never a provider.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import {
  GATEWAY_OPERATIONS,
  type BalanceAccountType,
  type GatewayBalance,
  type GatewayOperationsPort,
} from '../../integrations/gateway/gateway-operations.port';
import { PROVIDER_CAPABILITIES } from '../../integrations/gateway/provider-capabilities';
import { PAYMENT_PROVIDERS, type PaymentProvider } from '../payments/domain/payment-event';
import { ApprovalsService } from './approvals/approvals.service';
import { currenciesLeftUncovered } from './domain/routing-safety';
import type { ChangeResult } from './feature-flags.service';
import { OpsChangeApplier } from './ops-change-applier';
import { OpsConfigRepository, type ProviderRow } from './ops-config.repository';

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

export interface ProviderPatch {
  readonly enabled?: boolean;
  readonly health?: 'healthy' | 'degraded' | 'down';
  readonly note?: string | null;
  readonly reason?: string;
}

export interface ProviderView {
  readonly row: ProviderRow;
  readonly currencies: readonly string[];
  readonly enabledRules: number;
}

@Injectable()
export class ProviderOpsService {
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly applier: OpsChangeApplier,
    private readonly approvals: ApprovalsService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort
  ) {}

  async list(): Promise<ProviderView[]> {
    const [providers, rules] = await Promise.all([
      this.config.listProviders(),
      this.config.listRules(),
    ]);
    return providers.map((row) => this.view(row, rules));
  }

  async get(provider: string): Promise<ProviderView> {
    const all = await this.list();
    const found = all.find((p) => p.row.provider === provider);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  async update(
    provider: string,
    patch: ProviderPatch,
    staff: Staff
  ): Promise<ChangeResult<ProviderView>> {
    if (!(PAYMENT_PROVIDERS as readonly string[]).includes(provider))
      throw new AppError('NOT_FOUND');
    if (patch.enabled === undefined && patch.health === undefined && patch.note === undefined) {
      throw new AppError('OPS_INVALID', {
        messageParams: { reason: 'no_change' },
        details: { reason: 'no_change' },
      });
    }
    const result = await this.unitOfWork.run(async (tx) => {
      const current = await this.config.lockProvider(tx, provider);
      if (!current) throw new AppError('NOT_FOUND');
      const takesOutOfService =
        current.enabled &&
        (patch.enabled === false || (patch.health === 'down' && current.health !== 'down'));
      if (takesOutOfService) {
        const [providers, rules] = await Promise.all([
          this.config.listProviders(tx),
          this.config.listRules({}, tx),
        ]);
        const uncovered = currenciesLeftUncovered(
          provider as PaymentProvider,
          providers.map((p) => ({ provider: p.provider as PaymentProvider, enabled: p.enabled })),
          rules.map((r) => ({
            ref: r.ref,
            currency: r.currency,
            provider: r.provider as PaymentProvider,
            enabled: r.enabled,
          }))
        );
        if (uncovered.length > 0) {
          if (!patch.reason) {
            throw new AppError('UNSAFE_CONFIGURATION', {
              messageParams: { reason: 'currencies_without_a_route' },
              details: { reason: 'approval_needs_a_reason', uncoveredCurrencies: uncovered },
            });
          }
          const { approval } = await this.approvals.request(
            tx,
            {
              kind: 'provider.disable',
              resourceType: 'provider',
              resourceId: provider,
              payload: {
                provider,
                ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
                ...(patch.health !== undefined ? { health: patch.health } : {}),
                ...(patch.note !== undefined ? { note: patch.note } : {}),
                uncoveredCurrencies: uncovered,
              },
              reason: patch.reason,
            },
            staff
          );
          return { kind: 'approval_required' as const, approval };
        }
      }
      await this.applier.setProvider(
        tx,
        provider,
        { enabled: patch.enabled, health: patch.health, note: patch.note },
        staff.userId,
        'direct'
      );
      return { kind: 'applied' as const };
    });
    if (result.kind === 'approval_required') return result;
    return { kind: 'applied', value: await this.get(provider) };
  }

  /** The provider's balance as the gateway reports it, in minor units. */
  async balance(
    provider: string,
    accountType: BalanceAccountType,
    currency: string
  ): Promise<GatewayBalance> {
    if (!(PAYMENT_PROVIDERS as readonly string[]).includes(provider))
      throw new AppError('NOT_FOUND');
    const known = provider as PaymentProvider;
    if (!(PROVIDER_CAPABILITIES[known].currencies as readonly string[]).includes(currency)) {
      throw new AppError('OPS_INVALID', {
        messageParams: { reason: 'currency_not_supported' },
        details: { reason: 'currency_not_supported' },
      });
    }
    return this.gateway.getBalance(known, accountType, currency);
  }

  private view(
    row: ProviderRow,
    rules: ReadonlyArray<{ provider: string; enabled: boolean }>
  ): ProviderView {
    const capabilities = PROVIDER_CAPABILITIES[row.provider as PaymentProvider];
    return {
      row,
      currencies: capabilities.currencies,
      enabledRules: rules.filter((r) => r.enabled && r.provider === row.provider).length,
    };
  }
}
