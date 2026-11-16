/**
 * Provider statement matching (spec 6.8 run 3). Pure.
 *
 * Statement rows are matched to core transactions in two passes:
 *
 *   1. by provider reference: the row's reference equals the transaction's
 *      `provider_transaction_id`. If the amount or currency differ, the row is a `mismatch`:
 *      the provider says money moved, but not the amount core recorded;
 *   2. by amount, currency and date window, for rows no reference matched: the closest
 *      completed transaction of the same amount and currency within the window, among
 *      transactions that carry no provider reference of their own.
 *
 * A row whose reference repeats inside the statement, or was matched by an earlier statement,
 * is a `duplicate` and matches nothing. Each transaction matches at most one row. What is
 * left over on either side is an exception: unmatched rows and unmatched core transactions.
 */
export interface StatementRowInput {
  readonly rowNo: number;
  readonly providerRef: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: Date;
}

export interface CoreCandidate {
  readonly id: string;
  readonly ref: string;
  readonly providerTransactionId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly completedAt: Date;
}

export type RowMatchStatus =
  'matched_reference' | 'matched_amount' | 'mismatch' | 'duplicate' | 'unmatched';

export interface RowMatch {
  readonly rowNo: number;
  readonly status: RowMatchStatus;
  readonly transactionId: string | null;
  readonly transactionRef: string | null;
  readonly note: string | null;
}

export interface MatchResult {
  readonly rows: readonly RowMatch[];
  readonly unmatchedCore: readonly CoreCandidate[];
}

export interface MatchOptions {
  readonly windowMs: number;
  /** References an earlier statement already matched: repeating one is a duplicate. */
  readonly previouslyMatchedRefs: ReadonlySet<string>;
}

export function matchStatement(
  rows: readonly StatementRowInput[],
  candidates: readonly CoreCandidate[],
  options: MatchOptions
): MatchResult {
  const used = new Set<string>();
  const byRef = new Map<string, CoreCandidate>();
  for (const c of candidates) {
    if (c.providerTransactionId !== null) byRef.set(c.providerTransactionId, c);
  }
  const ordered = [...rows].sort((a, b) => a.rowNo - b.rowNo);
  const seenRefs = new Set<string>();
  const results = new Map<number, RowMatch>();

  // Duplicates first, so they never take a transaction a genuine row needs.
  const live: StatementRowInput[] = [];
  for (const row of ordered) {
    if (seenRefs.has(row.providerRef) || options.previouslyMatchedRefs.has(row.providerRef)) {
      results.set(row.rowNo, {
        rowNo: row.rowNo,
        status: 'duplicate',
        transactionId: null,
        transactionRef: null,
        note: seenRefs.has(row.providerRef)
          ? 'repeated_in_statement'
          : 'matched_by_earlier_statement',
      });
      continue;
    }
    seenRefs.add(row.providerRef);
    live.push(row);
  }

  const unresolved: StatementRowInput[] = [];
  for (const row of live) {
    const candidate = byRef.get(row.providerRef);
    if (!candidate || used.has(candidate.id)) {
      unresolved.push(row);
      continue;
    }
    used.add(candidate.id);
    const same = candidate.amountMinor === row.amountMinor && candidate.currency === row.currency;
    results.set(row.rowNo, {
      rowNo: row.rowNo,
      status: same ? 'matched_reference' : 'mismatch',
      transactionId: candidate.id,
      transactionRef: candidate.ref,
      note: same ? null : 'amount_or_currency_differs',
    });
  }

  for (const row of unresolved) {
    let best: CoreCandidate | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      if (used.has(c.id) || c.providerTransactionId !== null) continue;
      if (c.amountMinor !== row.amountMinor || c.currency !== row.currency) continue;
      const gap = Math.abs(c.completedAt.getTime() - row.occurredAt.getTime());
      if (gap > options.windowMs) continue;
      if (gap < bestGap || (gap === bestGap && best !== undefined && c.ref < best.ref)) {
        best = c;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.id);
      results.set(row.rowNo, {
        rowNo: row.rowNo,
        status: 'matched_amount',
        transactionId: best.id,
        transactionRef: best.ref,
        note: null,
      });
    } else {
      results.set(row.rowNo, {
        rowNo: row.rowNo,
        status: 'unmatched',
        transactionId: null,
        transactionRef: null,
        note: null,
      });
    }
  }

  return {
    rows: ordered.map((r) => results.get(r.rowNo) as RowMatch),
    unmatchedCore: candidates.filter((c) => !used.has(c.id)),
  };
}
