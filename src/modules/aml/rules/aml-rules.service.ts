/**
 * AML rule configuration (spec 6.13): create, change, enable and disable monitoring rules.
 *
 * Invariants upheld:
 *  - A rule's params are valid for its type before they are stored (`parseRuleParams`), so
 *    monitoring never meets a rule it cannot read.
 *  - Every change bumps the version, writes the new snapshot to the append-only
 *    `aml_rule_versions`, and writes an audit row, in one transaction. An alert records the
 *    version that fired it, so "what was the rule when this alert was raised" always has an
 *    answer.
 *  - A rule's type and code never change; a different kind of rule is a different rule.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { Clock } from '../../../common/clock/clock';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { AppError } from '../../../common/errors/app-error';
import { uuidv7 } from '../../../common/ids/ids';
import { CLOCK } from '../../../common/tokens';
import { parseRuleParams } from '../domain/rule-params';
import { AmlRulesRepository, type RulePatch, type RuleRow } from './aml-rules.repository';

export interface CreateRuleInput {
  readonly code: string;
  readonly name: string;
  readonly description?: string;
  readonly ruleType: string;
  readonly params: Record<string, unknown>;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly action: 'flag' | 'hold' | 'block';
  readonly enabled?: boolean;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date | null;
}

export interface UpdateRuleInput {
  readonly name?: string;
  readonly description?: string;
  readonly params?: Record<string, unknown>;
  readonly severity?: 'low' | 'medium' | 'high' | 'critical';
  readonly action?: 'flag' | 'hold' | 'block';
  readonly enabled?: boolean;
  readonly effectiveFrom?: Date;
  readonly effectiveTo?: Date | null;
  /** Why the rule changed; kept in the version history. */
  readonly reason?: string;
}

export function ruleSnapshot(row: RuleRow): Record<string, unknown> {
  return {
    code: row.code,
    name: row.name,
    ruleType: row.ruleType,
    params: row.params,
    severity: row.severity,
    action: row.action,
    enabled: row.enabled,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    version: row.version,
  };
}

function invalid(issues: string[]): AppError {
  return new AppError('AML_RULE_INVALID', {
    messageParams: { reason: issues[0] ?? 'invalid' },
    details: { issues },
  });
}

@Injectable()
export class AmlRulesService {
  constructor(
    private readonly rules: AmlRulesRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  list(): Promise<RuleRow[]> {
    return this.rules.list();
  }

  async get(code: string): Promise<RuleRow> {
    const row = await this.rules.findByCode(code);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  async create(input: CreateRuleInput, actorUserId: string): Promise<RuleRow> {
    const parsed = parseRuleParams(input.ruleType, input.params);
    if (!parsed.ok) throw invalid(parsed.issues);
    const now = this.clock.now();
    const effectiveFrom = input.effectiveFrom ?? now;
    if (input.effectiveTo && input.effectiveTo <= effectiveFrom) {
      throw invalid(['effectiveTo: must be after effectiveFrom']);
    }
    return this.unitOfWork.run(async (tx) => {
      if (await this.rules.findByCode(input.code, tx)) {
        throw invalid([`code: ${input.code} is already in use`]);
      }
      const row = await this.rules.insert(tx, {
        id: uuidv7(now),
        code: input.code,
        name: input.name,
        description: input.description ?? '',
        ruleType: input.ruleType,
        params: parsed.rule.params,
        severity: input.severity,
        action: input.action,
        enabled: input.enabled ?? false,
        version: 1,
        effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        updatedBy: actorUserId,
      });
      await this.rules.insertVersion(tx, {
        id: uuidv7(now),
        ruleId: row.id,
        version: 1,
        snapshot: ruleSnapshot(row),
        changedBy: actorUserId,
        reason: 'created',
      });
      await this.audit.record(tx, {
        action: 'aml.rule.created',
        resourceType: 'aml_rule',
        resourceId: row.code,
        after: ruleSnapshot(row),
      });
      return row;
    });
  }

  async update(code: string, input: UpdateRuleInput, actorUserId: string): Promise<RuleRow> {
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const current = await this.rules.lockByCode(tx, code);
      if (!current) throw new AppError('NOT_FOUND');
      let params = current.params;
      if (input.params !== undefined) {
        const parsed = parseRuleParams(current.ruleType, input.params);
        if (!parsed.ok) throw invalid(parsed.issues);
        params = parsed.rule.params;
      }
      const effectiveFrom = input.effectiveFrom ?? current.effectiveFrom;
      const effectiveTo = input.effectiveTo === undefined ? current.effectiveTo : input.effectiveTo;
      if (effectiveTo && effectiveTo <= effectiveFrom) {
        throw invalid(['effectiveTo: must be after effectiveFrom']);
      }
      const patch: RulePatch = {
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        params,
        severity: input.severity ?? current.severity,
        action: input.action ?? current.action,
        enabled: input.enabled ?? current.enabled,
        effectiveFrom,
        effectiveTo,
        version: current.version + 1,
        updatedBy: actorUserId,
      };
      const row = await this.rules.update(tx, current.id, patch);
      await this.rules.insertVersion(tx, {
        id: uuidv7(now),
        ruleId: row.id,
        version: row.version,
        snapshot: ruleSnapshot(row),
        changedBy: actorUserId,
        reason: input.reason ?? null,
      });
      await this.audit.record(tx, {
        action: 'aml.rule.updated',
        resourceType: 'aml_rule',
        resourceId: row.code,
        before: ruleSnapshot(current),
        after: ruleSnapshot(row),
      });
      return row;
    });
  }

  versions(code: string) {
    return this.get(code).then((rule) => this.rules.versions(rule.id));
  }
}
