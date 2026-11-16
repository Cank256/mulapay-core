/**
 * Reconciliation run kinds, scopes and run keys (spec 6.8). Pure.
 *
 * A run key names the business window a run covers, so the same window is the same run:
 * asking for it twice returns the first run and creates no second set of exceptions. A
 * scope names what the run looks at; two runs of one kind and scope never overlap in time.
 */
export const RUN_KINDS = [
  'gateway_gap',
  'ledger_integrity',
  'provider_statement',
  'balance_proof',
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export function isRunKind(value: string): value is RunKind {
  return (RUN_KINDS as readonly string[]).includes(value);
}

export interface RunScope {
  readonly environment: 'test' | 'live';
  readonly currency?: string;
  readonly merchantId?: string;
  /** Statement ref, for a provider statement run. */
  readonly statement?: string;
}

/** Canonical text of a scope: equal scopes always give equal keys. */
export function scopeKeyOf(scope: RunScope): string {
  return [
    `env=${scope.environment}`,
    `ccy=${scope.currency ?? '*'}`,
    `mch=${scope.merchantId ?? '*'}`,
    `stm=${scope.statement ?? '*'}`,
  ].join(';');
}

export function scopeRecord(scope: RunScope): Record<string, string> {
  const out: Record<string, string> = { environment: scope.environment };
  if (scope.currency) out.currency = scope.currency;
  if (scope.merchantId) out.merchantId = scope.merchantId;
  if (scope.statement) out.statement = scope.statement;
  return out;
}

/** Start of the bucket of `seconds` that contains `at`. */
export function bucketStart(at: Date, seconds: number): Date {
  const ms = seconds * 1000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/**
 * The key of a scheduled run. Gap runs bucket by the configured interval, integrity runs
 * by hour and the balance proof by UTC day, so a duplicate tick is the same run. The scope
 * is part of the key: the same window can be run for different scopes.
 */
export function scheduledRunKey(
  kind: RunKind,
  at: Date,
  scope: RunScope,
  gapIntervalSeconds: number
): string {
  const scopePart = scopeKeyOf(scope);
  switch (kind) {
    case 'gateway_gap':
      return `gap:${bucketStart(at, gapIntervalSeconds).toISOString()}:${scopePart}`;
    case 'ledger_integrity':
      return `integrity:${bucketStart(at, 3600).toISOString()}:${scopePart}`;
    case 'balance_proof':
      return `proof:${bucketStart(at, 86400).toISOString().slice(0, 10)}:${scopePart}`;
    case 'provider_statement':
      return `statement:${scope.statement ?? 'unknown'}`;
  }
}

/** A manual run is keyed by the caller's idempotency key: repeating it repeats nothing. */
export function manualRunKey(kind: RunKind, idempotencyKey: string): string {
  return `manual:${kind}:${idempotencyKey}`;
}
