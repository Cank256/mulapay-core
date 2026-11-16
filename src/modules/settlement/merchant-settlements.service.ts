/**
 * What a merchant can read about its own settlements (spec 7.1, 7.2). Live money only: a test
 * environment never settles, so it sees an empty list and a 404, the same 404 as a settlement
 * of another merchant or one that is still a draft.
 */
import { Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import { AppError } from '../../common/errors/app-error';
import { SettlementBatchService } from './settlement-batch.service';
import type { BatchRow } from './settlement-batches.repository';
import { SettlementEligibilityRepository } from './settlement-eligibility.repository';
import { SettlementReportsRepository } from './settlement-reports.repository';
import { SettlementReportsService } from './settlement-reports.service';
import { toSettlementItemView, toSettlementView, type SettlementView } from './settlement.views';
import { UnitOfWork } from '../../common/db/unit-of-work';

@Injectable()
export class MerchantSettlementsService {
  constructor(
    private readonly batches: SettlementBatchService,
    private readonly reports: SettlementReportsService,
    private readonly eligibility: SettlementEligibilityRepository,
    private readonly refs: SettlementReportsRepository,
    private readonly unitOfWork: UnitOfWork
  ) {}

  async list(scope: MerchantScope, query: { limit: number; cursor?: string }) {
    if (scope.environment !== 'live') return { items: [] as SettlementView[], nextCursor: null };
    const page = await this.batches.list({
      merchantId: scope.merchantId,
      hideDrafts: true,
      ...query,
    });
    return {
      items: await Promise.all(page.items.map((b) => this.view(b))),
      nextCursor: page.nextCursor,
    };
  }

  async get(scope: MerchantScope, ref: string): Promise<SettlementView> {
    return this.view(await this.find(scope, ref));
  }

  async items(scope: MerchantScope, ref: string, query: { limit: number; cursor?: string }) {
    const page = await this.batches.items(await this.find(scope, ref), query);
    return { items: page.items.map(toSettlementItemView), nextCursor: page.nextCursor };
  }

  async statement(scope: MerchantScope, ref: string) {
    return this.reports.statement(await this.find(scope, ref), 'merchant');
  }

  async csv(scope: MerchantScope, ref: string) {
    const file = await this.reports.csv(await this.find(scope, ref), 'merchant');
    return { ...file, contentType: 'text/csv' as const };
  }

  private async find(scope: MerchantScope, ref: string): Promise<BatchRow> {
    if (scope.environment !== 'live') throw new AppError('NOT_FOUND');
    return this.batches.getForMerchant(scope.merchantId, ref);
  }

  private async view(batch: BatchRow): Promise<SettlementView> {
    const payout = batch.payoutTransactionId
      ? await this.unitOfWork.run((tx) =>
          this.eligibility.payoutTransaction(tx, batch.payoutTransactionId as string, false)
        )
      : undefined;
    return toSettlementView(batch, payout?.ref ?? null);
  }
}
