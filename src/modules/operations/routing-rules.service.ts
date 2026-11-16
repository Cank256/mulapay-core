/**
 * Routing rule edits (spec 6.2, 6.14). The router that reads these rules is Phase 4; this is
 * the configuration it will use.
 *
 * Invariants upheld, under an advisory lock per currency so concurrent edits see one another:
 *  - A rule names a provider that supports its currency (`provider-capabilities.ts`), and an
 *    enabled rule names an enabled provider. Anything else is `UNSAFE_CONFIGURATION`.
 *  - Two rules cannot match exactly the same traffic for the same provider.
 *  - Deleting a rule is always an approval request. Disabling the last enabled rule of a
 *    currency is too, because the currency would have no route (`no_route_available`).
 *  - A rule's currency never changes: create a new rule instead.
 *  - Every change is audited with what changed.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import type { PaymentProvider } from '../payments/domain/payment-event';
import { ApprovalsService } from './approvals/approvals.service';
import { isLastEnabledRuleOfCurrency, ruleProblem } from './domain/routing-safety';
import type { ChangeResult } from './feature-flags.service';
import { OpsConfigRepository, type RuleRow } from './ops-config.repository';

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

export interface RuleInput {
  readonly priority: number;
  readonly currency: string;
  readonly country?: string;
  readonly channel?: 'mobile_money' | 'card' | 'bank' | '*';
  readonly minAmountMinor?: bigint | null;
  readonly maxAmountMinor?: bigint | null;
  readonly msisdnPrefix?: string | null;
  readonly provider: string;
  readonly weight?: number;
  readonly enabled?: boolean;
}
export type RulePatch = Partial<Omit<RuleInput, 'currency'>> & { readonly reason?: string };

const sameTraffic = (a: RuleRow, b: Partial<RuleRow> & { provider: string }): boolean =>
  a.currency === (b.currency ?? a.currency) &&
  a.country === (b.country ?? a.country) &&
  a.channel === (b.channel ?? a.channel) &&
  a.minAmountMinor === (b.minAmountMinor === undefined ? a.minAmountMinor : b.minAmountMinor) &&
  a.maxAmountMinor === (b.maxAmountMinor === undefined ? a.maxAmountMinor : b.maxAmountMinor) &&
  a.msisdnPrefix === (b.msisdnPrefix === undefined ? a.msisdnPrefix : b.msisdnPrefix) &&
  a.provider === b.provider;

@Injectable()
export class RoutingRulesService {
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly approvals: ApprovalsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  list(filter: { currency?: string; provider?: string }): Promise<RuleRow[]> {
    return this.config.listRules(filter);
  }

  async get(ref: string): Promise<RuleRow> {
    const rule = await this.config.findRule(ref);
    if (!rule) throw new AppError('NOT_FOUND');
    return rule;
  }

  async create(input: RuleInput, staff: Staff): Promise<RuleRow> {
    return this.unitOfWork.run(async (tx) => {
      await this.config.lockCurrencyRules(tx, input.currency);
      const enabled = input.enabled ?? true;
      await this.assertSafe(tx, input.provider, input.currency, enabled);
      const existing = await this.config.listRules({ currency: input.currency }, tx);
      const candidate = {
        currency: input.currency,
        country: input.country ?? '*',
        channel: input.channel ?? '*',
        minAmountMinor: input.minAmountMinor ?? null,
        maxAmountMinor: input.maxAmountMinor ?? null,
        msisdnPrefix: input.msisdnPrefix ?? null,
        provider: input.provider,
      };
      if (existing.some((r) => sameTraffic(r, candidate))) {
        throw new AppError('UNSAFE_CONFIGURATION', {
          messageParams: { reason: 'duplicate_rule' },
          details: { reason: 'duplicate_rule' },
        });
      }
      const now = this.clock.now();
      const rule = await this.config.insertRule(tx, {
        id: uuidv7(now),
        ref: publicId('routingRule', now),
        priority: input.priority,
        ...candidate,
        weight: input.weight ?? 100,
        enabled,
        updatedBy: staff.userId,
        createdAt: now,
      });
      await this.audit.record(tx, {
        action: 'routing_rule.created',
        resourceType: 'routing_rule',
        resourceId: rule.ref,
        after: snapshot(rule),
      });
      return rule;
    });
  }

  async update(ref: string, patch: RulePatch, staff: Staff): Promise<ChangeResult<RuleRow>> {
    return this.unitOfWork.run(async (tx) => {
      const probe = await this.config.findRule(ref, tx);
      if (!probe) throw new AppError('NOT_FOUND');
      await this.config.lockCurrencyRules(tx, probe.currency);
      const rule = await this.config.lockRule(tx, ref);
      if (!rule) throw new AppError('NOT_FOUND');
      const siblings = await this.config.listRules({ currency: rule.currency }, tx);
      const states = siblings.map(toState);

      if (patch.enabled === false && isLastEnabledRuleOfCurrency(toState(rule), states)) {
        if (!patch.reason) {
          throw new AppError('UNSAFE_CONFIGURATION', {
            messageParams: { reason: 'last_route_for_currency' },
            details: { reason: 'approval_needs_a_reason', currency: rule.currency },
          });
        }
        const { approval } = await this.approvals.request(
          tx,
          {
            kind: 'routing_rule.remove',
            resourceType: 'routing_rule',
            resourceId: rule.ref,
            payload: { rule: rule.ref, action: 'disable' },
            reason: patch.reason,
          },
          staff
        );
        return { kind: 'approval_required' as const, approval };
      }
      const provider = patch.provider ?? rule.provider;
      const enabled = patch.enabled ?? rule.enabled;
      if (patch.provider !== undefined || patch.enabled === true) {
        await this.assertSafe(tx, provider, rule.currency, enabled);
      }
      const next = {
        country: patch.country ?? rule.country,
        channel: patch.channel ?? rule.channel,
        minAmountMinor:
          patch.minAmountMinor === undefined ? rule.minAmountMinor : patch.minAmountMinor,
        maxAmountMinor:
          patch.maxAmountMinor === undefined ? rule.maxAmountMinor : patch.maxAmountMinor,
        msisdnPrefix: patch.msisdnPrefix === undefined ? rule.msisdnPrefix : patch.msisdnPrefix,
        provider,
      };
      if (
        siblings.some(
          (r) => r.ref !== rule.ref && sameTraffic(r, { ...next, currency: rule.currency })
        )
      ) {
        throw new AppError('UNSAFE_CONFIGURATION', {
          messageParams: { reason: 'duplicate_rule' },
          details: { reason: 'duplicate_rule' },
        });
      }
      const updated = await this.config.updateRule(tx, rule.id, {
        ...next,
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.weight !== undefined ? { weight: patch.weight } : {}),
        enabled,
        updatedBy: staff.userId,
      });
      await this.audit.record(tx, {
        action: 'routing_rule.updated',
        resourceType: 'routing_rule',
        resourceId: rule.ref,
        before: snapshot(rule),
        after: snapshot(updated),
      });
      return { kind: 'applied' as const, value: updated };
    });
  }

  /** Deleting is destructive: it is always an approval request. */
  async remove(
    ref: string,
    reason: string,
    staff: Staff
  ): Promise<{ approval: Awaited<ReturnType<ApprovalsService['request']>>['approval'] }> {
    return this.unitOfWork.run(async (tx) => {
      if (!(await this.config.findRule(ref, tx))) throw new AppError('NOT_FOUND');
      const { approval } = await this.approvals.request(
        tx,
        {
          kind: 'routing_rule.remove',
          resourceType: 'routing_rule',
          resourceId: ref,
          payload: { rule: ref, action: 'delete' },
          reason,
        },
        staff
      );
      return { approval };
    });
  }

  private async assertSafe(
    tx: Transaction,
    provider: string,
    currency: string,
    enabled: boolean
  ): Promise<void> {
    const providers = await this.config.listProviders(tx);
    const problem = ruleProblem(
      provider,
      currency,
      providers.map((p) => ({ provider: p.provider as PaymentProvider, enabled: p.enabled })),
      enabled
    );
    if (problem) {
      throw new AppError('UNSAFE_CONFIGURATION', {
        messageParams: { reason: problem },
        details: { reason: problem, provider, currency },
      });
    }
  }
}

function toState(r: RuleRow) {
  return {
    ref: r.ref,
    currency: r.currency,
    provider: r.provider as PaymentProvider,
    enabled: r.enabled,
  };
}

function snapshot(r: RuleRow): Record<string, unknown> {
  return {
    currency: r.currency,
    provider: r.provider,
    priority: r.priority,
    weight: r.weight,
    enabled: r.enabled,
    country: r.country,
    channel: r.channel,
    min: r.minAmountMinor?.toString() ?? null,
    max: r.maxAmountMinor?.toString() ?? null,
    msisdnPrefix: r.msisdnPrefix,
  };
}
