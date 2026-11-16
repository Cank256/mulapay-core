/**
 * The operational changes themselves, in one place, so the direct path (a safe change made at
 * once) and the approved path (the same change after a second person agreed) cannot differ.
 * Each method runs in the caller's transaction, re-checks that the change is still valid, writes
 * its audit row (naming whether it was approved), and returns what it did.
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Transaction } from '../../common/db/database.types';
import { AppError } from '../../common/errors/app-error';
import { opsActions } from '../../common/telemetry/metrics';
import { FlagCache } from './flag-cache';
import { OpsConfigRepository } from './ops-config.repository';

export type Via = 'direct' | { approval: string };
const viaOf = (via: Via) => (via === 'direct' ? 'direct' : `approval:${via.approval}`);

export interface FlagChange {
  readonly enabled?: boolean;
  readonly rolloutPercent?: number;
  /** Internal merchant ids. */
  readonly merchantAllowlist?: readonly string[];
}

@Injectable()
export class OpsChangeApplier {
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly audit: AuditService,
    private readonly flagCache: FlagCache
  ) {}

  async setFlag(
    tx: Transaction,
    key: string,
    change: FlagChange,
    updatedBy: string,
    via: Via
  ): Promise<Record<string, unknown>> {
    const flag = await this.config.lockFlag(tx, key);
    if (!flag) throw new AppError('NOT_FOUND');
    const updated = await this.config.updateFlag(tx, flag.id, {
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      ...(change.rolloutPercent !== undefined ? { rolloutPercent: change.rolloutPercent } : {}),
      ...(change.merchantAllowlist ? { merchantAllowlist: [...change.merchantAllowlist] } : {}),
      updatedBy,
    });
    this.flagCache.clear();
    const before = {
      enabled: flag.enabled,
      rolloutPercent: flag.rolloutPercent,
      allowlist: flag.merchantAllowlist.length,
    };
    const after = {
      enabled: updated.enabled,
      rolloutPercent: updated.rolloutPercent,
      allowlist: updated.merchantAllowlist.length,
      via: viaOf(via),
    };
    await this.audit.record(tx, {
      action: 'feature_flag.changed',
      resourceType: 'feature_flag',
      resourceId: key,
      before,
      after,
    });
    opsActions.inc({ action: 'feature_flag.changed' });
    return { key, before, after };
  }

  /**
   * Changes a provider's switch, health or note. Taking it out of service (disabling it, or
   * marking it down) is the change that needs care: the router skips such a provider.
   */
  async setProvider(
    tx: Transaction,
    provider: string,
    patch: { enabled?: boolean; health?: 'healthy' | 'degraded' | 'down'; note?: string | null },
    updatedBy: string,
    via: Via
  ): Promise<Record<string, unknown>> {
    const current = await this.config.lockProvider(tx, provider);
    if (!current) throw new AppError('NOT_FOUND');
    const updated = await this.config.updateProvider(tx, provider, {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.health !== undefined ? { health: patch.health } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedBy,
    });
    const outOfService =
      (current.enabled && !updated.enabled) ||
      (current.health !== 'down' && updated.health === 'down');
    const action = outOfService ? 'provider.disabled' : 'provider.updated';
    await this.audit.record(tx, {
      action,
      resourceType: 'provider',
      resourceId: provider,
      before: { enabled: current.enabled, health: current.health, note: current.note },
      after: {
        enabled: updated.enabled,
        health: updated.health,
        note: updated.note,
        via: viaOf(via),
      },
    });
    opsActions.inc({ action });
    return { provider, enabled: updated.enabled, health: updated.health };
  }

  async removeRule(
    tx: Transaction,
    ref: string,
    action: 'delete' | 'disable',
    updatedBy: string,
    via: Via
  ): Promise<Record<string, unknown>> {
    const probe = await this.config.findRule(ref, tx);
    if (!probe) {
      throw new AppError('APPROVAL_INVALID', {
        messageParams: { reason: 'rule_gone' },
        details: { reason: 'rule_gone' },
      });
    }
    // Rule changes of one currency are serialised, so "the last rule" is decided on a stable set.
    await this.config.lockCurrencyRules(tx, probe.currency);
    const rule = await this.config.lockRule(tx, ref);
    if (!rule) {
      throw new AppError('APPROVAL_INVALID', {
        messageParams: { reason: 'rule_gone' },
        details: { reason: 'rule_gone' },
      });
    }
    if (action === 'delete') await this.config.deleteRule(tx, rule.id);
    else await this.config.updateRule(tx, rule.id, { enabled: false, updatedBy });
    await this.audit.record(tx, {
      action: action === 'delete' ? 'routing_rule.deleted' : 'routing_rule.disabled',
      resourceType: 'routing_rule',
      resourceId: ref,
      before: {
        currency: rule.currency,
        provider: rule.provider,
        enabled: rule.enabled,
        priority: rule.priority,
      },
      after: { removed: action === 'delete', enabled: false, via: viaOf(via) },
    });
    opsActions.inc({ action: `routing_rule.${action === 'delete' ? 'deleted' : 'disabled'}` });
    return { rule: ref, action };
  }

  async rewindCursor(
    tx: Transaction,
    name: string,
    position: bigint,
    via: Via
  ): Promise<Record<string, unknown>> {
    const cursor = await this.config.lockCursor(tx, name);
    if (!cursor) throw new AppError('NOT_FOUND');
    if (position >= cursor.position) {
      throw new AppError('APPROVAL_INVALID', {
        messageParams: { reason: 'not_a_rewind' },
        details: { reason: 'not_a_rewind', current: cursor.position.toString() },
      });
    }
    await this.config.setCursorPosition(tx, name, position);
    await this.audit.record(tx, {
      action: 'consumer_cursor.rewound',
      resourceType: 'consumer_cursor',
      resourceId: name,
      before: { position: cursor.position.toString() },
      after: { position: position.toString(), via: viaOf(via) },
    });
    opsActions.inc({ action: 'consumer_cursor.rewound' });
    return { name, from: cursor.position.toString(), to: position.toString() };
  }
}
