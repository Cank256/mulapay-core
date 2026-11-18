/**
 * Payouts service: public API facade for payout operations.
 * Thin wrapper over creator and repository for consistency with payments/refunds pattern.
 */
import { Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { PayoutCreator, type NewPayoutInput } from './payout-creator';
import { toPayoutView, type PayoutView } from './payout.views';
import { PayoutsRepository } from './payouts.repository';

export interface PayoutListQuery {
  readonly status?: string;
  readonly currency?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

@Injectable()
export class PayoutsService {
  constructor(
    private readonly creator: PayoutCreator,
    private readonly payouts: PayoutsRepository,
    private readonly unitOfWork: UnitOfWork
  ) {}

  /** Create a new payout (places hold, may require approval). */
  async create(scope: MerchantScope, input: NewPayoutInput): Promise<PayoutView> {
    return this.unitOfWork.run(async (tx: Transaction) => {
      const detail = await this.creator.create(tx, scope, input);
      return toPayoutView(detail);
    });
  }

  /** Get a single payout by ref. */
  async get(scope: MerchantScope, ref: string): Promise<PayoutView> {
    const detail = await this.payouts.findDetailByRef(scope, ref);
    if (!detail) throw new AppError('NOT_FOUND');
    return toPayoutView(detail);
  }

  /** List payouts with filtering and pagination. */
  async list(
    scope: MerchantScope,
    query: PayoutListQuery
  ): Promise<{ data: PayoutView[]; pagination: { limit: number; cursor: string | null; hasMore: boolean } }> {
    // TODO: Implement list method in PayoutsRepository
    // For now, return empty list
    return {
      data: [],
      pagination: {
        limit: query.limit,
        cursor: null,
        hasMore: false,
      },
    };
  }
}
