/**
 * Helpers for the dispute suites. Live money in XOF, which no other suite uses, so the
 * provider clearing account and the merchants are this suite's alone.
 */
import { sql, type TestMerchant } from './payments';
import { activeMerchant, succeedLivePayment, type ComplianceContext } from './compliance';
import type { StaffSession } from './identity';

export const DISPUTE_CURRENCY = 'XOF';

/** A live merchant that has collected `amount` XOF, and the payment's transaction ref. */
export async function merchantWithPayment(ctx: ComplianceContext, amount = 100_000n) {
  const merchant = await activeMerchant(ctx, 'disputed');
  const payment = await succeedLivePayment(ctx, merchant, {
    amountMinor: amount,
    currency: DISPUTE_CURRENCY,
  });
  const [txn] = await sql<{ ref: string }>('select ref from core.transaction_keys where id = $1', [
    payment.transactionId,
  ]);
  return { merchant, payment, txnRef: txn?.ref as string };
}

export function openDispute(
  staff: StaffSession,
  merchant: TestMerchant,
  txnRef: string,
  amountMinor: string,
  extra: Record<string, unknown> = {}
) {
  return staff.client.post('/admin/v1/disputes', {
    merchant: merchant.ref,
    transaction: txnRef,
    kind: 'chargeback',
    amountMinor,
    reasonCode: '4853',
    ...extra,
  });
}

export const balanceOf = (ctx: ComplianceContext, merchant: TestMerchant) =>
  ctx.balances.merchantBalance(merchant.id, 'live', DISPUTE_CURRENCY);

export function entryLines(entryRef: string) {
  return sql<{
    code: string;
    direction: string;
    amount_minor: string;
    kind: string;
    source: string;
  }>(
    `select a.code, l.direction, l.amount_minor::text, e.kind, e.source
       from core.journal_entries e
       join core.journal_lines l on l.entry_id = e.id and l.created_at = e.created_at
       join core.accounts a on a.id = l.account_id
      where e.ref = $1 order by l.line_no`,
    [entryRef]
  );
}

export const merchantEventTypes = async (merchantId: string) =>
  (
    await sql<{ type: string }>(
      'select type from core.merchant_events where merchant_id = $1 order by created_at',
      [merchantId]
    )
  ).map((r) => r.type);

export const entryCount = async (merchantId: string) =>
  Number(
    (
      await sql<{ n: string }>(
        'select count(*)::text as n from core.journal_entries where merchant_id = $1',
        [merchantId]
      )
    )[0]?.n
  );

export const auditActionsOf = async (resourceId: string) =>
  (
    await sql<{ action: string }>(
      `select action from core.audit_logs where resource_id = $1 and outcome = 'success' order by seq`,
      [resourceId]
    )
  ).map((r) => r.action);
