/**
 * Settlement reports (spec 6.9): the itemised statement of one batch, for the merchant to
 * download and for staff to audit. Both see the same amounts and items. Staff also see the
 * ledger entry refs and open reconciliation exceptions; the merchant sees the payout's own
 * reference, a masked destination and the provider's transaction id, never internal ids or
 * gateway identifiers.
 */
import { Injectable } from '@nestjs/common';
import { ledgerIdempotencyKey } from '../ledger/domain/posting';
import { toStatementCsv } from './domain/statement-csv';
import { SettlementBatchesRepository, type BatchRow } from './settlement-batches.repository';
import { SettlementDestinationsRepository } from './settlement-destinations.repository';
import { SettlementEligibilityRepository } from './settlement-eligibility.repository';
import { SettlementReportsRepository } from './settlement-reports.repository';
import {
  toSettlementItemView,
  toSettlementView,
  type SettlementItemView,
} from './settlement.views';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { MerchantsRepository } from '../merchants/merchants.repository';

const PAGE = 2000;
const MAX_STATEMENT_ITEMS = 200_000;

export type Audience = 'merchant' | 'staff';

export interface SettlementStatement {
  readonly settlement: ReturnType<typeof toSettlementView>;
  readonly merchant: string;
  readonly totals: Readonly<Record<string, string>>;
  readonly items: readonly SettlementItemView[];
  readonly payout: {
    readonly transaction: string | null;
    readonly status: string | null;
    readonly provider: string | null;
    readonly destination: string | null;
    readonly providerTransactionId: string | null;
  };
  readonly reconciliation: {
    readonly statementMatches: readonly { statement: string; row: number; status: string }[];
    readonly openExceptions: readonly { ref: string; kind: string; status: string }[];
    readonly ledgerEntries: readonly { name: string; ref: string }[];
  };
  readonly statusHistory: readonly { from: string | null; to: string; at: string }[];
}

@Injectable()
export class SettlementReportsService {
  constructor(
    private readonly batches: SettlementBatchesRepository,
    private readonly eligibility: SettlementEligibilityRepository,
    private readonly destinations: SettlementDestinationsRepository,
    private readonly reports: SettlementReportsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly unitOfWork: UnitOfWork
  ) {}

  async statement(batch: BatchRow, audience: Audience): Promise<SettlementStatement> {
    const items: SettlementItemView[] = [];
    let after: { kind: string; occurredAt: Date | null; id: string } | undefined;
    for (;;) {
      const page = await this.batches.itemsOf(batch.id, after, PAGE);
      for (const row of page.slice(0, PAGE)) items.push(toSettlementItemView(row));
      const last = page.slice(0, PAGE).at(-1);
      if (page.length <= PAGE || !last || items.length >= MAX_STATEMENT_ITEMS) break;
      after = { kind: last.kind, occurredAt: last.occurredAt, id: last.id };
    }
    const payout = batch.payoutTransactionId
      ? await this.unitOfWork.run((tx) =>
          this.eligibility.payoutTransaction(tx, batch.payoutTransactionId as string, false)
        )
      : undefined;
    const destination = batch.destinationId
      ? await this.unitOfWork.run((tx) =>
          this.destinations.findById(tx, batch.destinationId as string)
        )
      : undefined;
    const merchant = await this.merchants.findById(batch.merchantId);
    const view = toSettlementView(batch, payout?.ref ?? null);

    const matches = payout ? await this.reports.statementMatches(payout.id) : [];
    const exceptions =
      payout && audience === 'staff' ? await this.reports.exceptionsFor(payout.id) : [];
    const keys = (['release', 'confirm'] as const).map((s) => ({
      name: s,
      key: ledgerIdempotencyKey('settlement', `${batch.ref}:${s}`),
    }));
    const refs =
      audience === 'staff' && batch.status === 'paid'
        ? await this.reports.entryRefs(keys.map((k) => k.key))
        : new Map<string, string>();
    const events = await this.batches.eventsOf(batch.id);

    return {
      settlement: view,
      merchant: merchant?.ref ?? '',
      totals: {
        gross_minor: view.grossMinor,
        refunds_minor: view.refundMinor,
        fees_minor: view.feeMinor,
        reserve_withheld_minor: view.reserveWithheldMinor,
        reserve_released_minor: view.reserveReleasedMinor,
        dispute_holds_minor: view.disputeHoldMinor,
        aml_holds_minor: view.amlHoldMinor,
        net_minor: view.netMinor,
      },
      items,
      payout: {
        transaction: payout?.ref ?? null,
        status: payout?.status ?? null,
        provider: payout?.provider ?? null,
        destination: destination?.display ?? null,
        providerTransactionId: payout?.providerTransactionId ?? null,
      },
      reconciliation: {
        statementMatches: matches.map((m) => ({
          statement: m.statement,
          row: m.row,
          status: m.status,
        })),
        openExceptions: exceptions.filter(
          (e) => e.status === 'open' || e.status === 'investigating'
        ),
        ledgerEntries: keys.flatMap((k) => {
          const ref = refs.get(k.key);
          return ref ? [{ name: k.name, ref }] : [];
        }),
      },
      statusHistory: events
        .filter((e) => e.kind === 'transition' || e.fromStatus !== e.toStatus)
        .map((e) => ({ from: e.fromStatus, to: e.toStatus, at: e.createdAt.toISOString() })),
    };
  }

  /** The statement as CSV text, ready to download. */
  async csv(batch: BatchRow, audience: Audience): Promise<{ filename: string; content: string }> {
    const statement = await this.statement(batch, audience);
    return {
      filename: `${batch.ref}.csv`,
      content: toStatementCsv({
        settlement: batch.ref,
        currency: batch.currency,
        periodStart: statement.settlement.periodStart,
        periodEnd: statement.settlement.periodEnd,
        rows: statement.items,
        totals: statement.totals,
      }),
    };
  }
}
