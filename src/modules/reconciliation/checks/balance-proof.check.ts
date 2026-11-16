/**
 * The daily balance proof (spec 6.8 run 4). Three independent comparisons:
 *
 *  1. Provider accounts against the gateway. For each provider and currency the ledger's
 *     `1000:provider_clearing` is compared with the gateway's collection balance and
 *     `1010:provider_float` with its disbursement balance, each within
 *     `RECON_BALANCE_TOLERANCE_MINOR`. The sum of the two is reported alongside (spec:
 *     "the sum of provider clearing and float accounts equals what the gateway reports").
 *  2. Merchant payable against merchant balances: the payable balance the ledger holds for
 *     each merchant against the posted balance the balances service reports for them.
 *  3. Rolling reserve: each merchant's `2010:merchant_reserve` against their unreleased
 *     `reserve_entries`.
 *
 * A gateway that cannot be asked is an exception of its own (`balance_provider_unavailable`),
 * never a silent pass. Nothing here changes a balance.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  GATEWAY_OPERATIONS,
  type BalanceAccountType,
  type GatewayOperationsPort,
} from '../../../integrations/gateway/gateway-operations.port';
import { APP_CONFIG } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import { BalancesService } from '../../balances/balances.service';
import type { PaymentProvider } from '../../payments/domain/payment-event';
import { ReconciliationQueriesRepository } from '../reconciliation-queries.repository';
import type {
  ReconciliationCheck,
  RunCheckContext,
  RunCheckResult,
} from '../reconciliation-run.service';

const MERCHANT_ROW_LIMIT = 10_000;
const ACCOUNT_TYPE: Record<'provider_clearing' | 'provider_float', BalanceAccountType> = {
  provider_clearing: 'collection',
  provider_float: 'disbursement',
};

@Injectable()
export class BalanceProofCheck implements ReconciliationCheck {
  readonly kind = 'balance_proof' as const;

  constructor(
    private readonly queries: ReconciliationQueriesRepository,
    private readonly balances: BalancesService,
    @Inject(GATEWAY_OPERATIONS) private readonly gateway: GatewayOperationsPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  async execute(ctx: RunCheckContext): Promise<RunCheckResult> {
    const provider = await this.providerAccounts(ctx);
    const merchants = await this.merchantPayables(ctx);
    const reserves = await this.reserves(ctx);
    return {
      checked: provider.checked + merchants.checked + reserves.checked,
      matched: provider.matched + merchants.matched + reserves.matched,
      summary: {
        providerComparisons: provider.checked,
        providerSums: provider.sums,
        merchantsChecked: merchants.checked,
        reservesChecked: reserves.checked,
      },
    };
  }

  private async providerAccounts(ctx: RunCheckContext) {
    const { environment, currency } = ctx.scope;
    const sums: Record<string, { ledgerMinor: string; gatewayMinor: string }> = {};
    if (environment !== 'live') return { checked: 0, matched: 0, sums };
    const tolerance = this.config.RECON_BALANCE_TOLERANCE_MINOR;
    const rows = await this.queries.providerLedgerBalances(environment, currency);
    const totals = new Map<string, { ledger: bigint; gateway: bigint; complete: boolean }>();
    let checked = 0;
    let matched = 0;
    for (const row of rows) {
      checked += 1;
      const accountType = ACCOUNT_TYPE[row.purpose];
      const reported = await this.gateway.getBalance(
        row.provider as PaymentProvider,
        accountType,
        row.currency
      );
      const key = `${row.provider}:${row.currency}`;
      const total = totals.get(key) ?? { ledger: 0n, gateway: 0n, complete: true };
      total.ledger += row.balanceMinor;
      if (reported.kind === 'unavailable') {
        total.complete = false;
        totals.set(key, total);
        await ctx.raise({
          kind: 'balance_provider_unavailable',
          dedupeKey: `proof:unavailable:${row.provider}:${accountType}:${row.currency}`,
          environment,
          currency: row.currency,
          expected: { gatewayBalance: accountType },
          actual: { provider: row.provider, reason: reported.reason },
        });
        continue;
      }
      total.gateway += reported.availableMinor;
      totals.set(key, total);
      const diff = absDiff(row.balanceMinor, reported.availableMinor);
      if (diff <= tolerance) {
        matched += 1;
        continue;
      }
      await ctx.raise({
        kind: 'balance_provider_mismatch',
        dedupeKey: `proof:provider:${row.provider}:${row.purpose}:${row.currency}`,
        environment,
        currency: row.currency,
        amountMinor: diff,
        expected: { account: `${row.purpose}:${row.provider}`, balanceMinor: row.balanceMinor },
        actual: {
          gatewayAccount: accountType,
          balanceMinor: reported.availableMinor,
          differenceMinor: reported.availableMinor - row.balanceMinor,
          toleranceMinor: tolerance,
        },
      });
    }
    for (const [key, t] of totals) {
      sums[key] = {
        ledgerMinor: t.ledger.toString(),
        gatewayMinor: t.complete ? t.gateway.toString() : 'unavailable',
      };
    }
    return { checked, matched, sums };
  }

  private async merchantPayables(ctx: RunCheckContext) {
    const rows = await this.queries.merchantPayables(
      ctx.scope.environment,
      { currency: ctx.scope.currency, merchantId: ctx.scope.merchantId },
      MERCHANT_ROW_LIMIT
    );
    let matched = 0;
    for (const row of rows) {
      const view = await this.balances.merchantBalance(
        row.merchantId,
        ctx.scope.environment,
        row.currency
      );
      if (view.postedMinor === row.postedMinor) {
        matched += 1;
        continue;
      }
      await ctx.raise({
        kind: 'balance_merchant_mismatch',
        dedupeKey: `proof:merchant:${row.merchantRef}:${row.currency}`,
        environment: ctx.scope.environment,
        currency: row.currency,
        merchantId: row.merchantId,
        amountMinor: absDiff(view.postedMinor, row.postedMinor),
        expected: { payablePostedMinor: row.postedMinor },
        actual: { merchant: row.merchantRef, balancePostedMinor: view.postedMinor },
      });
    }
    return { checked: rows.length, matched };
  }

  private async reserves(ctx: RunCheckContext) {
    if (ctx.scope.environment !== 'live') return { checked: 0, matched: 0 };
    const rows = await this.queries.reserveComparisons(
      { currency: ctx.scope.currency, merchantId: ctx.scope.merchantId },
      MERCHANT_ROW_LIMIT
    );
    let matched = 0;
    for (const row of rows) {
      if (row.accountMinor === row.entriesMinor) {
        matched += 1;
        continue;
      }
      await ctx.raise({
        kind: 'reserve_mismatch',
        dedupeKey: `proof:reserve:${row.merchantRef}:${row.currency}`,
        environment: 'live',
        currency: row.currency,
        merchantId: row.merchantId,
        amountMinor: absDiff(row.accountMinor, row.entriesMinor),
        expected: { reserveEntriesMinor: row.entriesMinor },
        actual: { merchant: row.merchantRef, reserveAccountMinor: row.accountMinor },
      });
    }
    return { checked: rows.length, matched };
  }
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}
