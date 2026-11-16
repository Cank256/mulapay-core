/**
 * Rolling reserve configuration (spec 6.9): `percent_bps` of gross is withheld from each
 * settlement and held for `hold_days` before it is released into a later batch. A merchant
 * with no row uses the platform defaults `ROLLING_RESERVE_BPS` and `ROLLING_RESERVE_HOLD_DAYS`.
 * Changing the rate affects later batches only: a batch's reserve is fixed when it is created.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { rollingReserves } from '../../db/schema';
import { MerchantsRepository } from '../merchants/merchants.repository';

export interface ReserveTerms {
  readonly percentBps: number;
  readonly holdDays: number;
  readonly source: 'merchant' | 'default';
}

@Injectable()
export class RollingReserveService {
  constructor(
    @Inject(DB_RW) private readonly db: Executor,
    private readonly merchants: MerchantsRepository,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** The terms that apply to this merchant and currency right now. */
  async termsFor(executor: Executor, merchantId: string, currency: string): Promise<ReserveTerms> {
    const [row] = await executor
      .select()
      .from(rollingReserves)
      .where(
        and(
          eq(rollingReserves.merchantId, merchantId),
          eq(rollingReserves.currency, currency),
          eq(rollingReserves.active, true)
        )
      );
    return row
      ? { percentBps: row.percentBps, holdDays: row.holdDays, source: 'merchant' }
      : {
          percentBps: this.config.ROLLING_RESERVE_BPS,
          holdDays: this.config.ROLLING_RESERVE_HOLD_DAYS,
          source: 'default',
        };
  }

  async set(
    merchantRef: string,
    input: { currency: string; percentBps: number; holdDays: number; active: boolean },
    actorId: string
  ): Promise<ReserveTerms> {
    if (!isSupportedCurrency(input.currency))
      throw new AppError('SETTLEMENT_CYCLE_INVALID', { details: { field: 'currency' } });
    if (!Number.isInteger(input.percentBps) || input.percentBps < 0 || input.percentBps > 10_000) {
      throw new AppError('SETTLEMENT_CYCLE_INVALID', { details: { field: 'percentBps' } });
    }
    if (!Number.isInteger(input.holdDays) || input.holdDays < 0 || input.holdDays > 365) {
      throw new AppError('SETTLEMENT_CYCLE_INVALID', { details: { field: 'holdDays' } });
    }
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const merchant = await this.merchants.lockByRef(tx, merchantRef);
      if (!merchant) throw new AppError('NOT_FOUND');
      const before = await this.termsFor(tx, merchant.id, input.currency);
      await tx
        .insert(rollingReserves)
        .values({
          id: uuidv7(now),
          merchantId: merchant.id,
          currency: input.currency,
          percentBps: input.percentBps,
          holdDays: input.holdDays,
          active: input.active,
          createdBy: `user:${actorId}`,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [rollingReserves.merchantId, rollingReserves.currency],
          set: { percentBps: input.percentBps, holdDays: input.holdDays, active: input.active },
        });
      const after = await this.termsFor(tx, merchant.id, input.currency);
      await this.audit.record(tx, {
        action: 'settlement.rolling_reserve.set',
        resourceType: 'merchant',
        resourceId: merchant.ref,
        merchantId: merchant.id,
        before: { ...before },
        after: { ...after, currency: input.currency },
      });
      return after;
    });
  }
}
