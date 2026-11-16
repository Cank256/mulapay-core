/**
 * The four kinds of approval (spec 11) and what each does once a second person agrees. Each
 * kind validates its payload when requested and performs the change through `OpsChangeApplier`,
 * the same code the direct path uses.
 */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Transaction } from '../../../common/db/database.types';
import { AppError } from '../../../common/errors/app-error';
import { OpsChangeApplier } from '../ops-change-applier';
import { OpsConfigRepository } from '../ops-config.repository';
import type { ApprovalContext, ApprovalExecutor } from './approval-executor';
import type { ApprovalRow } from './approvals.repository';

function parse<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new AppError('APPROVAL_INVALID', {
      messageParams: { reason: 'bad_payload' },
      details: { reason: 'bad_payload', fields: result.error.issues.map((i) => i.path.join('.')) },
    });
  }
  return result.data;
}

const cursorPayload = z.strictObject({
  name: z.string().min(1).max(60),
  position: z.string().regex(/^\d{1,18}$/),
});
const flagPayload = z.strictObject({
  key: z.string().min(1).max(60),
  enabled: z.boolean().optional(),
  rolloutPercent: z.number().int().min(0).max(100).optional(),
  merchantAllowlist: z.array(z.uuid()).max(500).optional(),
});
const providerPayload = z.strictObject({
  provider: z.enum(['mtn', 'airtel', 'flutterwave']),
  enabled: z.boolean().optional(),
  health: z.enum(['healthy', 'degraded', 'down']).optional(),
  note: z.string().max(500).nullable().optional(),
  uncoveredCurrencies: z.array(z.string()).max(40),
});
const rulePayload = z.strictObject({
  rule: z.string().min(1).max(64),
  action: z.enum(['delete', 'disable']),
});

@Injectable()
export class ConsumerCursorRewindExecutor implements ApprovalExecutor {
  readonly kind = 'consumer_cursor.rewind';
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly applier: OpsChangeApplier
  ) {}

  async prepare(tx: Transaction, payload: Readonly<Record<string, unknown>>) {
    const p = parse(cursorPayload, payload);
    const cursor = await this.config.lockCursor(tx, p.name);
    if (!cursor) throw new AppError('NOT_FOUND');
    if (BigInt(p.position) >= cursor.position) {
      throw new AppError('APPROVAL_INVALID', {
        messageParams: { reason: 'not_a_rewind' },
        details: { reason: 'not_a_rewind', current: cursor.position.toString() },
      });
    }
    return { ...p, from: cursor.position.toString() };
  }

  execute(tx: Transaction, approval: ApprovalRow, _ctx: ApprovalContext) {
    const p = parse(cursorPayload, {
      name: approval.payload.name,
      position: approval.payload.position,
    });
    return this.applier.rewindCursor(tx, p.name, BigInt(p.position), { approval: approval.ref });
  }
}

@Injectable()
export class FeatureFlagChangeExecutor implements ApprovalExecutor {
  readonly kind = 'feature_flag.change';
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly applier: OpsChangeApplier
  ) {}

  async prepare(tx: Transaction, payload: Readonly<Record<string, unknown>>) {
    const p = parse(flagPayload, payload);
    if (!(await this.config.findFlag(p.key, tx))) throw new AppError('NOT_FOUND');
    if (
      p.enabled === undefined &&
      p.rolloutPercent === undefined &&
      p.merchantAllowlist === undefined
    ) {
      throw new AppError('APPROVAL_INVALID', {
        messageParams: { reason: 'no_change' },
        details: { reason: 'no_change' },
      });
    }
    return p;
  }

  execute(tx: Transaction, approval: ApprovalRow, _ctx: ApprovalContext) {
    const p = parse(flagPayload, approval.payload);
    return this.applier.setFlag(
      tx,
      p.key,
      {
        enabled: p.enabled,
        rolloutPercent: p.rolloutPercent,
        merchantAllowlist: p.merchantAllowlist,
      },
      approval.requestedBy,
      { approval: approval.ref }
    );
  }
}

@Injectable()
export class ProviderDisableExecutor implements ApprovalExecutor {
  readonly kind = 'provider.disable';
  constructor(private readonly applier: OpsChangeApplier) {}

  async prepare(_tx: Transaction, payload: Readonly<Record<string, unknown>>) {
    return parse(providerPayload, payload);
  }

  execute(tx: Transaction, approval: ApprovalRow, _ctx: ApprovalContext) {
    const p = parse(providerPayload, approval.payload);
    return this.applier.setProvider(
      tx,
      p.provider,
      { enabled: p.enabled, health: p.health, note: p.note },
      approval.requestedBy,
      { approval: approval.ref }
    );
  }
}

@Injectable()
export class RoutingRuleRemoveExecutor implements ApprovalExecutor {
  readonly kind = 'routing_rule.remove';
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly applier: OpsChangeApplier
  ) {}

  async prepare(tx: Transaction, payload: Readonly<Record<string, unknown>>) {
    const p = parse(rulePayload, payload);
    if (!(await this.config.findRule(p.rule, tx))) throw new AppError('NOT_FOUND');
    return p;
  }

  execute(tx: Transaction, approval: ApprovalRow, _ctx: ApprovalContext) {
    const p = parse(rulePayload, approval.payload);
    return this.applier.removeRule(tx, p.rule, p.action, approval.requestedBy, {
      approval: approval.ref,
    });
  }
}
