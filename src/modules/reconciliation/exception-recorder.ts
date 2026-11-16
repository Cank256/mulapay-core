/**
 * Raises reconciliation exceptions (spec 6.8). The one place that inserts them.
 *
 * Raising never changes financial state: it writes a row. The same discrepancy seen again
 * (same `dedupeKey` while the exception is open or investigating) counts one more
 * occurrence instead of creating a second exception, so an hourly run over a standing
 * problem produces one exception, not twenty-four a day.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { defaultSeverity, type ExceptionKind, type Severity } from './domain/exception-kinds';
import {
  ReconciliationExceptionsRepository,
  type ExceptionRow,
} from './reconciliation-exceptions.repository';

export interface RaiseInput {
  readonly kind: ExceptionKind;
  /** Names the discrepancy: the same thing found twice has the same key. */
  readonly dedupeKey: string;
  readonly severity?: Severity;
  readonly environment: 'test' | 'live';
  readonly currency?: string;
  readonly amountMinor?: bigint | null;
  readonly merchantId?: string;
  readonly transactionId?: string;
  readonly gatewayOperationId?: string;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly actual: Readonly<Record<string, unknown>>;
}

export interface RaisedException {
  readonly exception: ExceptionRow;
  /** False when the discrepancy was already open and only its counter moved. */
  readonly created: boolean;
}

/** Plain JSON: bigint becomes a decimal string, dates ISO strings, undefined is dropped. */
export function toJsonObject(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const convert = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(convert);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, inner]) => inner !== undefined)
          .map(([k, inner]) => [k, convert(inner)])
      );
    }
    return v;
  };
  return convert(value) as Record<string, unknown>;
}

@Injectable()
export class ReconciliationExceptionRecorder {
  constructor(
    private readonly exceptions: ReconciliationExceptionsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async raise(tx: Executor, runId: string | null, input: RaiseInput): Promise<RaisedException> {
    const now = this.clock.now();
    const actual = toJsonObject(input.actual);
    const amountMinor = input.amountMinor ?? null;
    const inserted = await this.exceptions.insertIfNew(tx, {
      id: uuidv7(now),
      ref: publicId('reconException', now),
      runId,
      lastRunId: runId,
      kind: input.kind,
      severity: input.severity ?? defaultSeverity(input.kind),
      dedupeKey: input.dedupeKey,
      environment: input.environment,
      currency: input.currency ?? null,
      amountMinor,
      merchantId: input.merchantId ?? null,
      transactionId: input.transactionId ?? null,
      gatewayOperationId: input.gatewayOperationId ?? null,
      expected: toJsonObject(input.expected),
      actual,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
    });
    if (inserted) return { exception: inserted, created: true };
    const seen = await this.exceptions.markSeenAgain(tx, input.dedupeKey, {
      runId: runId as string,
      at: now,
      actual,
      amountMinor,
    });
    if (!seen) {
      // Resolved between the insert attempt and the update: the next run raises a new one.
      throw new Error('exception was resolved while it was being re-observed');
    }
    return { exception: seen, created: false };
  }
}
