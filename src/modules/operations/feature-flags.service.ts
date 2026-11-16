/**
 * Feature flags (spec 6.14, 9.2 rule 8). A change in an environment that needs approval
 * (`OPS_FLAG_CHANGE_APPROVAL`: production by default) becomes an approval request and changes
 * nothing until a second person approves; elsewhere it applies at once. Both paths use
 * `OpsChangeApplier`, so they write the same audit row.
 *
 * Reads (`isEnabled`) come from a 30 second in-process cache and never touch the database on a
 * hit. A flag that does not exist is off.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { ApprovalsService } from './approvals/approvals.service';
import type { ApprovalRow } from './approvals/approvals.repository';
import { evaluateFlag, type FlagState } from './domain/flag-evaluation';
import { FlagCache } from './flag-cache';
import { OpsChangeApplier } from './ops-change-applier';
import { OpsConfigRepository, type FlagRow } from './ops-config.repository';

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

export type ChangeResult<T> =
  | { readonly kind: 'applied'; readonly value: T }
  | { readonly kind: 'approval_required'; readonly approval: ApprovalRow };

export interface FlagPatch {
  readonly enabled?: boolean;
  readonly rolloutPercent?: number;
  readonly merchantAllowlistRefs?: readonly string[];
}

@Injectable()
export class FeatureFlagsService {
  constructor(
    private readonly config: OpsConfigRepository,
    private readonly applier: OpsChangeApplier,
    private readonly approvals: ApprovalsService,
    private readonly merchants: MerchantsRepository,
    private readonly cache: FlagCache,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  list(): Promise<FlagRow[]> {
    return this.config.listFlags();
  }

  async get(key: string): Promise<FlagRow> {
    const flag = await this.config.findFlag(key);
    if (!flag) throw new AppError('NOT_FOUND');
    return flag;
  }

  /** Registers a flag. It starts off, so creating one changes no behaviour. */
  async create(input: { key: string; description: string; rolloutPercent?: number }, staff: Staff) {
    return this.unitOfWork.run(async (tx) => {
      if (await this.config.findFlag(input.key, tx)) {
        throw new AppError('OPS_INVALID', {
          messageParams: { reason: 'flag_exists' },
          details: { reason: 'flag_exists' },
        });
      }
      const flag = await this.config.insertFlag(tx, {
        id: uuidv7(this.clock.now()),
        key: input.key,
        description: input.description,
        enabled: false,
        rolloutPercent: input.rolloutPercent ?? 100,
        updatedBy: staff.userId,
      });
      await this.audit.record(tx, {
        action: 'feature_flag.created',
        resourceType: 'feature_flag',
        resourceId: flag.key,
        after: { enabled: false, rolloutPercent: flag.rolloutPercent },
      });
      this.cache.clear();
      return flag;
    });
  }

  /** Whether changes need a second person in this environment. */
  get needsApproval(): boolean {
    const mode = this.appConfig.OPS_FLAG_CHANGE_APPROVAL;
    return mode === 'always' || (mode === 'production' && this.appConfig.NODE_ENV === 'production');
  }

  async change(
    key: string,
    patch: FlagPatch,
    reason: string | undefined,
    staff: Staff
  ): Promise<ChangeResult<FlagRow>> {
    if (
      patch.enabled === undefined &&
      patch.rolloutPercent === undefined &&
      !patch.merchantAllowlistRefs
    ) {
      throw new AppError('OPS_INVALID', {
        messageParams: { reason: 'no_change' },
        details: { reason: 'no_change' },
      });
    }
    const allowlist = patch.merchantAllowlistRefs
      ? await this.merchantIds(patch.merchantAllowlistRefs)
      : undefined;
    const change = {
      enabled: patch.enabled,
      rolloutPercent: patch.rolloutPercent,
      merchantAllowlist: allowlist,
    };
    return this.unitOfWork.run(async (tx) => {
      if (!(await this.config.findFlag(key, tx))) throw new AppError('NOT_FOUND');
      if (this.needsApproval) {
        if (!reason) {
          throw new AppError('OPS_INVALID', {
            messageParams: { reason: 'reason_required' },
            details: { reason: 'reason_required' },
          });
        }
        const { approval } = await this.approvals.request(
          tx,
          {
            kind: 'feature_flag.change',
            resourceType: 'feature_flag',
            resourceId: key,
            payload: { key, ...stripUndefined(change) },
            reason,
          },
          staff
        );
        return { kind: 'approval_required', approval };
      }
      await this.applier.setFlag(tx, key, change, staff.userId, 'direct');
      const flag = await this.config.findFlag(key, tx);
      if (!flag) throw new Error('flag vanished after update');
      return { kind: 'applied', value: flag };
    });
  }

  /** Whether a flag applies to a merchant, from a 30 second cache. */
  async isEnabled(key: string, merchantId?: string): Promise<boolean> {
    const now = this.clock.now().getTime();
    let flags = this.cache.get(now);
    if (!flags) {
      flags = new Map<string, FlagState>(
        (await this.config.listFlags()).map((f) => [
          f.key,
          {
            key: f.key,
            enabled: f.enabled,
            rolloutPercent: f.rolloutPercent,
            merchantAllowlist: f.merchantAllowlist,
          },
        ])
      );
      this.cache.set(now, flags);
    }
    const flag = flags.get(key);
    return flag ? evaluateFlag(flag, merchantId) : false;
  }

  private async merchantIds(refs: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const ref of new Set(refs)) {
      const merchant = await this.merchants.findByRef(ref);
      if (!merchant) throw new AppError('NOT_FOUND');
      ids.push(merchant.id);
    }
    return ids;
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
