/**
 * The SQL of each report type (spec 6.12). Every query:
 *  - uses `$n` placeholders only, never interpolating a value;
 *  - carries a `created_at` bound on each partitioned table it reads (spec 9.2 rule 6);
 *  - scopes merchant data by merchant and environment, from the request's scope and never from
 *    a parameter a merchant supplies;
 *  - selects every column as text in the order of its column list, ordered by a total key, so the
 *    cursor streams a stable result;
 *  - reads the replica (the cursor runs on the replica pool).
 *
 * `build` returns the SQL and its values. The worker feeds it to a server-side cursor.
 */
import type { Column } from './domain/report-format';
import type { ReportType } from './domain/report-params';

export interface ReportScope {
  readonly environment: 'test' | 'live';
  readonly merchantId?: string;
  readonly merchantRef?: string;
}

export interface BuiltQuery {
  readonly text: string;
  readonly values: unknown[];
}

export interface ReportDefinition {
  readonly columns: readonly Column[];
  build(
    scope: ReportScope,
    params: Record<string, unknown>,
    from: Date | null,
    to: Date | null
  ): BuiltQuery;
}

const text = (label: string): Column => ({ label, kind: 'text' });
const num = (label: string): Column => ({ label, kind: 'number' });
const ts = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function need(scope: ReportScope): string {
  if (!scope.merchantId) throw new Error('report needs a merchant scope');
  return scope.merchantId;
}

const TRANSACTION_COLUMNS: Column[] = [
  text('reference'),
  text('type'),
  text('status'),
  num('amount_minor'),
  num('fee_minor'),
  num('net_minor'),
  text('currency'),
  text('provider'),
  text('channel'),
  text('created_at'),
  text('completed_at'),
  text('failure_code'),
];

function transactionsQuery(fixedType?: string): ReportDefinition['build'] {
  return (scope, params, from, to) => ({
    text: `select t.ref, t.type, t.status, t.amount_minor::text, t.fee_minor::text, t.net_minor::text,
                  t.currency, t.provider, t.channel, ${ts('t.created_at')}, ${ts('t.completed_at')}, t.failure_code
             from core.transactions t
            where t.merchant_id = $1 and t.environment = $2
              and t.created_at >= $3 and t.created_at < $4
              and ($5::text is null or t.currency = $5)
              and ($6::text is null or t.status = $6)
              and ($7::text is null or t.type = $7)
            order by t.created_at, t.ref`,
    values: [
      need(scope),
      scope.environment,
      from,
      to,
      str(params.currency),
      str(params.status),
      fixedType ?? str(params.type),
    ],
  });
}

const MOVEMENT_SQL = `
  select ${ts('s.created_at')}, s.entry_ref, s.kind, s.description, s.debit, s.credit, s.balance
    from (
      select l.created_at, e.ref as entry_ref, e.kind, e.description,
             case when l.direction = 'debit' then l.amount_minor::text else '0' end as debit,
             case when l.direction = 'credit' then l.amount_minor::text else '0' end as credit,
             (opening.minor + sum(case when l.direction = a.normal_balance then l.amount_minor else -l.amount_minor end)
                over (order by l.created_at, e.ref, l.line_no))::text as balance,
             l.line_no, e.ref
        from core.journal_lines l
        join core.accounts a on a.id = l.account_id
        join core.journal_entries e on e.id = l.entry_id and e.created_at = l.created_at
        cross join lateral (
          select coalesce(sum(case when p.direction = a.normal_balance then p.amount_minor else -p.amount_minor end), 0) as minor
            from core.journal_lines p
           where p.account_id = a.id and p.currency = $3 and p.created_at < $4
        ) opening
       where a.code = $1 and a.environment = $2 and l.currency = $3
         and l.created_at >= $4 and l.created_at < $5
    ) s
   order by s.created_at, s.ref, s.line_no`;

const MOVEMENT_COLUMNS: Column[] = [
  text('posted_at'),
  text('entry'),
  text('kind'),
  text('description'),
  num('debit_minor'),
  num('credit_minor'),
  num('balance_minor'),
];

export const REPORT_DEFINITIONS: Record<ReportType, ReportDefinition> = {
  transactions: { columns: TRANSACTION_COLUMNS, build: transactionsQuery() },
  payouts: { columns: TRANSACTION_COLUMNS, build: transactionsQuery('payout') },
  refunds: { columns: TRANSACTION_COLUMNS, build: transactionsQuery('refund') },

  payments: {
    columns: [
      text('reference'),
      text('status'),
      num('amount_minor'),
      text('currency'),
      text('channel'),
      text('description'),
      text('created_at'),
      text('expires_at'),
    ],
    build: (scope, params, from, to) => ({
      text: `select p.ref, p.status, p.amount_minor::text, p.currency, p.channel, p.description,
                    ${ts('p.created_at')}, ${ts('p.expires_at')}
               from core.payments p
              where p.merchant_id = $1 and p.environment = $2
                and p.created_at >= $3 and p.created_at < $4
                and ($5::text is null or p.currency = $5)
                and ($6::text is null or p.status = $6)
              order by p.created_at, p.ref`,
      values: [need(scope), scope.environment, from, to, str(params.currency), str(params.status)],
    }),
  },

  fees: {
    columns: [
      text('reference'),
      text('type'),
      text('currency'),
      num('amount_minor'),
      num('fee_minor'),
      num('net_minor'),
      text('provider'),
      text('completed_at'),
    ],
    build: (scope, params, from, to) => ({
      text: `select t.ref, t.type, t.currency, t.amount_minor::text, t.fee_minor::text, t.net_minor::text,
                    t.provider, ${ts('t.completed_at')}
               from core.transactions t
              where t.merchant_id = $1 and t.environment = $2
                and t.created_at >= $3 and t.created_at < $4
                and t.status = 'succeeded' and t.fee_minor > 0
                and ($5::text is null or t.currency = $5)
              order by t.created_at, t.ref`,
      values: [need(scope), scope.environment, from, to, str(params.currency)],
    }),
  },

  balance_statement: {
    columns: MOVEMENT_COLUMNS,
    build: (scope, params, from, to) => ({
      text: MOVEMENT_SQL,
      values: [
        `2000:merchant_payable:${scope.merchantRef ?? ''}`,
        scope.environment,
        str(params.currency),
        from,
        to,
      ],
    }),
  },

  ledger_account_statement: {
    columns: MOVEMENT_COLUMNS,
    build: (scope, params, from, to) => ({
      text: MOVEMENT_SQL,
      values: [str(params.accountCode), scope.environment, str(params.currency), from, to],
    }),
  },

  settlement_statement: {
    columns: [
      text('settlement'),
      text('kind'),
      text('transaction'),
      num('amount_minor'),
      num('fee_minor'),
      num('net_minor'),
      text('occurred_at'),
    ],
    build: (scope, params) => ({
      text: `select b.ref, i.kind, i.transaction_ref, i.amount_minor::text, i.fee_minor::text, i.net_minor::text,
                    ${ts('i.occurred_at')}
               from core.settlement_batches b
               join core.settlement_items i on i.batch_id = b.id
              where b.merchant_id = $1 and b.ref = $2
              order by i.occurred_at nulls last, i.kind, i.transaction_ref nulls last, i.id`,
      values: [need(scope), str(params.settlement)],
    }),
  },

  merchant_performance: {
    columns: [
      text('merchant'),
      text('date'),
      text('currency'),
      text('channel'),
      text('provider'),
      num('payment_count'),
      num('payment_minor'),
      num('refund_count'),
      num('refund_minor'),
      num('payout_count'),
      num('payout_minor'),
      num('fee_minor'),
      num('success_count'),
      num('failure_count'),
      num('success_rate'),
    ],
    build: (scope, params, from, to) => ({
      text: `select m.ref, r.date::text, r.currency, r.channel, r.provider,
                    r.payment_count::text, r.payment_minor::text, r.refund_count::text, r.refund_minor::text,
                    r.payout_count::text, r.payout_minor::text, r.fee_minor::text,
                    r.success_count::text, r.failure_count::text,
                    case when r.success_count + r.failure_count = 0 then ''
                         else round(r.success_count::numeric / (r.success_count + r.failure_count), 4)::text end
               from core.daily_merchant_rollups r
               join core.merchants m on m.id = r.merchant_id
              where r.environment = $1
                and r.date >= ($2::timestamptz at time zone 'UTC')::date
                and r.date <= ($3::timestamptz at time zone 'UTC')::date
                and ($4::uuid is null or r.merchant_id = $4)
                and ($5::text is null or r.currency = $5)
              order by r.date, m.ref, r.currency, r.channel, r.provider`,
      values: [scope.environment, from, to, scope.merchantId ?? null, str(params.currency)],
    }),
  },

  reconciliation_exceptions: {
    columns: [
      text('reference'),
      text('kind'),
      text('severity'),
      text('status'),
      text('opened_at'),
      text('resolved_at'),
    ],
    build: (_scope, params, from, to) => ({
      text: `select x.ref, x.kind, x.severity, x.status, ${ts('x.created_at')}, ${ts('x.resolved_at')}
               from core.reconciliation_exceptions x
              where x.created_at >= $1 and x.created_at < $2
                and ($3::text is null or x.status = $3)
                and ($4::text is null or x.kind = $4)
              order by x.created_at, x.ref`,
      values: [from, to, str(params.status), str(params.kind)],
    }),
  },

  aml_alerts: {
    columns: [
      text('reference'),
      text('rule'),
      text('severity'),
      text('status'),
      text('merchant'),
      num('score'),
      text('created_at'),
      text('due_at'),
      text('resolved_at'),
    ],
    build: (_scope, params, from, to) => ({
      text: `select a.ref, a.rule_code, a.severity, a.status, m.ref, a.score::text,
                    ${ts('a.created_at')}, ${ts('a.due_at')}, ${ts('a.resolved_at')}
               from core.aml_alerts a
               join core.merchants m on m.id = a.merchant_id
              where a.created_at >= $1 and a.created_at < $2
                and ($3::text is null or a.status = $3)
                and ($4::text is null or a.severity = $4)
              order by a.created_at, a.ref`,
      values: [from, to, str(params.status), str(params.severity)],
    }),
  },

  kyc_status: {
    columns: [
      text('merchant'),
      text('legal_name'),
      text('kyc_level'),
      text('profile_level'),
      text('status'),
      text('submitted_at'),
      text('reviewed_at'),
      text('expires_at'),
    ],
    build: (_scope, params) => ({
      text: `select m.ref, m.legal_name, m.kyc_level::text, p.level::text, p.status,
                    ${ts('p.submitted_at')}, ${ts('p.reviewed_at')}, ${ts('p.expires_at')}
               from core.kyc_profiles p
               join core.merchants m on m.id = p.merchant_id
              where ($1::text is null or p.status = $1)
              order by m.ref`,
      values: [str(params.status)],
    }),
  },

  audit_trail: {
    columns: [
      num('seq'),
      text('at'),
      text('actor_type'),
      text('actor'),
      text('action'),
      text('resource_type'),
      text('resource'),
      text('outcome'),
      text('surface'),
      text('changed_fields'),
    ],
    build: (_scope, params, from, to) => ({
      text: `select l.seq::text, ${ts('l.created_at')}, l.actor_type, l.actor_id, l.action, l.resource_type,
                    l.resource_id, l.outcome, l.surface, array_to_string(l.changed_fields, ' ')
               from core.audit_logs l
              where l.created_at >= $1 and l.created_at < $2
                and ($3::text is null or l.action = $3)
                and ($4::text is null or l.resource_type = $4)
              order by l.created_at, l.seq`,
      values: [from, to, str(params.action), str(params.resourceType)],
    }),
  },
};
