/**
 * Whether a merchant may be paid out (spec 6.13: a block "suspends further payouts").
 *
 * Every path that sends money to a merchant (today the settlement release and its payout
 * submission, later the payouts module) asks here first. The answer comes from PostgreSQL,
 * the source of truth: an active row in `aml_blocks`. Redis is not consulted, because a
 * missed suspension would let money leave.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Executor } from '../../../common/db/database.types';
import { DB_RW } from '../../../common/db/tokens';
import { AppError } from '../../../common/errors/app-error';
import { AmlBlocksRepository } from './aml-blocks.repository';

@Injectable()
export class PayoutControlService {
  constructor(
    private readonly blocks: AmlBlocksRepository,
    @Inject(DB_RW) private readonly db: Executor
  ) {}

  async isSuspended(merchantId: string, tx: Executor = this.db): Promise<boolean> {
    return this.blocks.isSuspended(merchantId, tx);
  }

  /** Throws `PAYOUTS_SUSPENDED` when the merchant is blocked. Pass the caller's transaction when there is one. */
  async assertPayoutsAllowed(merchantId: string, tx: Executor = this.db): Promise<void> {
    if (await this.isSuspended(merchantId, tx)) throw new AppError('PAYOUTS_SUSPENDED');
  }
}
