/**
 * Idempotent execution of a request that creates a resource or moves money (spec 8.2).
 *
 * Postgres is the authority. In one transaction:
 *
 *  1. claim the key with an `in_flight` row (`INSERT ... ON CONFLICT`); a request that
 *     arrives while another with the same key is still running waits on the unique index
 *     for at most `LOCK_WAIT_MS`, then answers 409 `REQUEST_IN_PROGRESS` with `Retry-After`;
 *  2. if the key already exists: a different fingerprint is 409 `IDEMPOTENCY_KEY_REUSED`,
 *     and a completed one is replayed from the stored response;
 *  3. otherwise run the work, store its response on the row (`completed`), then `finalize`
 *     (the audit row) as the last statement.
 *
 * Because the claim and the work share a transaction, a request that fails leaves no key
 * behind and can be retried; a request that commits has its response stored atomically.
 * There is no window in which the work happened but the key did not, so a crash can never
 * cause a second execution of a committed request.
 *
 * The fingerprint is checked first in Redis (`IdempotencyMarker`) for an early 409, but
 * nothing depends on Redis being up.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { MerchantScope } from '../auth/merchant-scope';
import type { Clock } from '../clock/clock';
import { markAuditNotApplicable } from '../context/request-context';
import type { Transaction } from '../db/database.types';
import { UnitOfWork } from '../db/unit-of-work';
import { isLockNotAvailable } from '../db/pg-errors';
import { AppError } from '../errors/app-error';
import { uuidv7 } from '../ids/ids';
import { idempotencyReplays } from '../telemetry/metrics';
import { CLOCK } from '../tokens';
import { IDEMPOTENCY_TTL_SECONDS, IdempotencyMarker } from './idempotency-marker';
import { IdempotencyRepository } from './idempotency.repository';
import {
  IdempotentResponse,
  type IdempotencyContext,
  type IdempotentWork,
} from './idempotency.types';

/** How long a duplicate waits for the first request before answering 409. */
export const LOCK_WAIT_MS = 2000;
const RETRY_AFTER_SECONDS = 2;

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: IdempotencyRepository,
    private readonly marker: IdempotencyMarker,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Runs `work` at most once per `(merchant, environment, operation, key)` within 24 hours.
   * Returns the work's response, or the stored one with `replayed = true`.
   */
  async run<T>(
    scope: MerchantScope,
    ctx: IdempotencyContext,
    work: (tx: Transaction) => Promise<IdempotentWork<T>>
  ): Promise<IdempotentResponse<T>> {
    const marker = await this.marker.reserve(scope, ctx);
    if (marker === 'different') throw new AppError('IDEMPOTENCY_KEY_REUSED');
    try {
      const response = await this.execute(scope, ctx, work);
      if (response.replayed) {
        idempotencyReplays.inc({ scope: ctx.operation });
        // A replay changes nothing, so the request has no audit row of its own to write.
        markAuditNotApplicable();
      }
      return response;
    } catch (error) {
      if (marker === 'reserved') await this.marker.release(scope, ctx);
      if (isLockNotAvailable(error)) {
        throw new AppError('REQUEST_IN_PROGRESS', {
          retryAfterSeconds: RETRY_AFTER_SECONDS,
          cause: error,
        });
      }
      throw error;
    }
  }

  private execute<T>(
    scope: MerchantScope,
    ctx: IdempotencyContext,
    work: (tx: Transaction) => Promise<IdempotentWork<T>>
  ): Promise<IdempotentResponse<T>> {
    return this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      // Transaction-local, so it is safe behind PgBouncer. It bounds only the wait for a
      // concurrent request with the same key; the work runs without a lock timeout.
      await tx.execute(sql`select set_config('lock_timeout', ${String(LOCK_WAIT_MS)}, true)`);
      const claimed = await this.repository.claim(tx, {
        id: uuidv7(now),
        scope,
        operation: ctx.operation,
        key: ctx.key,
        fingerprint: ctx.fingerprint,
        now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_SECONDS * 1000),
      });
      await tx.execute(sql`select set_config('lock_timeout', '0', true)`);

      if (!claimed) {
        const existing = await this.repository.find(tx, scope, ctx.operation, ctx.key);
        // The row can only be missing if a retention job deleted it between the two statements.
        if (!existing) {
          throw new AppError('REQUEST_IN_PROGRESS', { retryAfterSeconds: RETRY_AFTER_SECONDS });
        }
        if (existing.requestFingerprint !== ctx.fingerprint) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED');
        }
        if (
          existing.status === 'completed' &&
          existing.responseStatus !== null &&
          existing.responseBody !== null
        ) {
          return new IdempotentResponse(existing.responseStatus, existing.responseBody as T, true);
        }
        throw new AppError('REQUEST_IN_PROGRESS', { retryAfterSeconds: RETRY_AFTER_SECONDS });
      }

      const result = await work(tx);
      await this.repository.complete(
        tx,
        claimed.id,
        result.statusCode,
        result.stored ?? result.body
      );
      if (result.finalize) await result.finalize(tx);
      return new IdempotentResponse(result.statusCode, result.body, false);
    });
  }
}
