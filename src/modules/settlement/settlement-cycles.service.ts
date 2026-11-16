/**
 * Settlement cycle configuration (spec 5.2, 6.9, 7.3 `/admin/v1/settlement/cycles`):
 * name, cron schedule, currency, delay, cutoff, zone and minimum payout. Cycles are never
 * deleted: a cycle that is no longer wanted is deactivated, and the scheduler stops running
 * it. Every change is audited with before and after.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { CLOCK } from '../../common/tokens';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { isValidCron } from './domain/cron';
import { isValidTimezone } from './domain/settlement-period';
import { SettlementCyclesRepository, type CycleRow } from './settlement-cycles.repository';

export interface CycleInput {
  readonly name: string;
  readonly schedule: string;
  readonly currency: string;
  readonly delayDays: number;
  readonly cutoffTime: string;
  readonly timezone: string;
  readonly minPayoutMinor: bigint;
}

function invalid(field: string): AppError {
  return new AppError('SETTLEMENT_CYCLE_INVALID', { details: { field } });
}

@Injectable()
export class SettlementCyclesService {
  constructor(
    private readonly cycles: SettlementCyclesRepository,
    private readonly merchants: MerchantsRepository,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async create(input: CycleInput, actorId: string): Promise<CycleRow> {
    this.validate(input);
    const now = this.clock.now();
    try {
      return await this.unitOfWork.run(async (tx) => {
        const row = await this.cycles.insert(tx, {
          id: uuidv7(now),
          ref: publicId('settlementCycle', now),
          ...input,
          createdBy: `user:${actorId}`,
          createdAt: now,
        });
        await this.audit.record(tx, {
          action: 'settlement.cycle.created',
          resourceType: 'settlement_cycle',
          resourceId: row.ref,
          after: view(row),
        });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'settlement_cycles_name_key')) throw invalid('name');
      throw error;
    }
  }

  async update(
    ref: string,
    patch: Partial<Omit<CycleInput, 'currency'>> & { active?: boolean }
  ): Promise<CycleRow> {
    return this.unitOfWork.run(async (tx) => {
      const before = await this.cycles.lockByRef(tx, ref);
      if (!before) throw new AppError('NOT_FOUND');
      const merged = { ...before, ...patch };
      this.validate(merged);
      const row = await this.cycles.update(tx, before.id, patch);
      await this.audit.record(tx, {
        action: 'settlement.cycle.updated',
        resourceType: 'settlement_cycle',
        resourceId: ref,
        before: view(before),
        after: view(row),
      });
      return row;
    });
  }

  /** Puts a merchant on a cycle, or takes it off (`cycleRef: null`). Only live money settles. */
  async assignMerchant(merchantRef: string, cycleRef: string | null): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const merchant = await this.merchants.lockByRef(tx, merchantRef);
      if (!merchant) throw new AppError('NOT_FOUND');
      const cycle = cycleRef ? await this.cycles.findByRef(cycleRef, tx) : undefined;
      if (cycleRef && !cycle) throw new AppError('NOT_FOUND');
      if (cycle && cycle.currency !== merchant.defaultCurrency) throw invalid('currency');
      await this.cycles.assignMerchant(tx, merchant.id, cycle?.id ?? null);
      await this.audit.record(tx, {
        action: 'settlement.cycle.merchant_assigned',
        resourceType: 'merchant',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        before: { cycle: merchant.settlementCycleId },
        after: { cycle: cycle?.ref ?? null },
      });
    });
  }

  async get(ref: string): Promise<CycleRow> {
    const row = await this.cycles.findByRef(ref);
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  list(onlyActive = false): Promise<CycleRow[]> {
    return this.cycles.list(onlyActive);
  }

  private validate(
    input: Omit<CycleInput, 'currency' | 'minPayoutMinor'> & {
      currency?: string;
      minPayoutMinor?: bigint;
    }
  ) {
    if (input.currency !== undefined && !isSupportedCurrency(input.currency))
      throw invalid('currency');
    if (!isValidTimezone(input.timezone)) throw invalid('timezone');
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.cutoffTime)) throw invalid('cutoffTime');
    if (!Number.isInteger(input.delayDays) || input.delayDays < 0 || input.delayDays > 90) {
      throw invalid('delayDays');
    }
    if (!isValidCron(input.schedule, input.timezone)) throw invalid('schedule');
    if (input.name.trim().length < 1 || input.name.length > 80) throw invalid('name');
    if (input.minPayoutMinor !== undefined && input.minPayoutMinor < 0n)
      throw invalid('minPayoutMinor');
  }
}

function view(row: CycleRow) {
  return {
    name: row.name,
    schedule: row.schedule,
    currency: row.currency,
    delayDays: row.delayDays,
    cutoffTime: row.cutoffTime,
    timezone: row.timezone,
    minPayoutMinor: row.minPayoutMinor,
    active: row.active,
  };
}
