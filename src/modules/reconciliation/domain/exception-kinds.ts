/**
 * The exceptions reconciliation can raise (spec 6.8) and how serious each is. Pure.
 *
 * `severity` orders the queue; it does not decide what happens. No exception changes
 * financial state by itself.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const EXCEPTION_KINDS = {
  // Gateway gap
  stale_processing_transaction: 'medium',
  gateway_state_differs: 'high',
  gateway_amount_mismatch: 'critical',
  core_transaction_missing_at_gateway: 'high',
  gateway_operation_missing_in_core: 'critical',
  late_conflicting_event: 'critical',
  // Ledger integrity
  ledger_unbalanced_entry: 'critical',
  ledger_balance_mismatch: 'critical',
  ledger_negative_merchant_payable: 'critical',
  ledger_negative_available_balance: 'critical',
  ledger_suspense_nonzero: 'high',
  ledger_totals_unbalanced: 'critical',
  // Provider statements
  statement_unmatched_row: 'high',
  statement_amount_mismatch: 'critical',
  statement_duplicate_row: 'medium',
  statement_unmatched_core_transaction: 'high',
  // Balance proof
  balance_provider_mismatch: 'critical',
  balance_provider_unavailable: 'medium',
  balance_merchant_mismatch: 'critical',
  reserve_mismatch: 'critical',
} as const satisfies Record<string, Severity>;
export type ExceptionKind = keyof typeof EXCEPTION_KINDS;

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

export function defaultSeverity(kind: ExceptionKind): Severity {
  return EXCEPTION_KINDS[kind];
}

export const EXCEPTION_STATUSES = ['open', 'investigating', 'resolved', 'written_off'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

export const OPEN_STATUSES: readonly ExceptionStatus[] = ['open', 'investigating'];
export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

export const RESOLUTIONS = ['matched_manually', 'corrected_with_reversal', 'written_off'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
