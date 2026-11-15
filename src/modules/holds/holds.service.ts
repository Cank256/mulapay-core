/**
 * Holds (spec 6.7): reservations against a merchant's available balance.
 *
 * Invariants upheld:
 *  - A hold is placed only if `available >= amount`, checked under a lock on the merchant's
 *    payable balance row. Concurrent placements for one merchant and currency serialise, so
 *    parallel payouts cannot overdraw (spec 12, concurrency).
 *  - Placement, capture and release are idempotent on their keys: the same key and the same
 *    parameters return the original result and change nothing; the same key with different
 *    parameters is refused.
 *  - A hold ends once. Capturing a released or expired hold, releasing a captured one, or
 *    capturing under a second key is an error, never a silent no-op.
 *  - Capture does not post to the ledger. The caller captures and posts the entry for the
 *    operation in one transaction, so the funds leave `available` through the posting at
 *    the same instant they stop being held.
 *  - Nothing here calls out of the process: it runs inside the caller's transaction.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import type { LedgerEnvironment } from '../accounts/domain/chart-of-accounts';
import { BalancesService } from '../balances/balances.service';
import {
  decideCapture,
  decideRelease,
  isDueForExpiry,
  type HoldSnapshot,
  type HoldState,
} from './domain/hold-state';
import { HoldsRepository, type HoldRow } from './holds.repository';
export interface PlaceHoldInput {
  readonly merchantId: string;
  readonly environment: LedgerEnvironment;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly reason: string;
  readonly transactionId?: string;
  /** Null (the default) means the hold never expires by the clock. */
  readonly expiresAt?: Date | null;
  readonly idempotencyKey: string;
  /** `user:{id}`, `api_key:{id}`, `system:{name}` or `job:{name}`. */
  readonly createdBy: string;
}
export interface HoldResult {
  readonly hold: HoldRow;
  /** True when the key had already placed (or ended) this hold; nothing was written. */
  readonly replayed: boolean;
}
export interface HoldSweepResult {
  readonly expired: number;
  readonly skipped: number;
  readonly failed: number;
}
const CREATED_BY = /^(user|api_key|system|job):[A-Za-z0-9._:-]{1,128}$/;
function invalidHold(reason: string): AppError {
  return new AppError('LEDGER_POSTING_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}
@Injectable()
export class HoldsService {
  constructor(
    private readonly holds: HoldsRepository,
    private readonly balances: BalancesService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}
  /** Places a hold, or returns the one this idempotency key placed before. */
  async place(tx: Executor, input: PlaceHoldInput): Promise<HoldResult> {
    this.validate(input);
    const now = this.clock.now();
    // The payable row lock serialises every placement for this merchant and currency.
    const balance = await this.balances.lockedMerchantBalance(
      tx,
      input.merchantId,
      input.environment,
      input.currency
    );
    const existing = await this.holds.findByKey(tx, input.environment, input.idempotencyKey);
    if (existing) {
      if (!sameRequest(existing, input)) throw new AppError('HOLD_CONFLICT');
      return { hold: existing, replayed: true };
    }
    if (balance.availableMinor < input.amountMinor) {
      throw new AppError('INSUFFICIENT_BALANCE', {
        details: {
          available: (balance.availableMinor < 0n ? 0n : balance.availableMinor).toString(),
          requested: input.amountMinor.toString(),
          currency: input.currency,
        },
      });
    }
    const hold = await this.holds.insert(tx, {
      id: uuidv7(now),
      ref: publicId('hold', now),
      merchantId: input.merchantId,
      environment: input.environment,
      accountId: balance.accountId,
      currency: input.currency,
      amountMinor: input.amountMinor,
      reason: input.reason,
      transactionId: input.transactionId ?? null,
      expiresAt: input.expiresAt ?? null,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.createdBy,
    });
    return { hold, replayed: false };
  }
  /**
   * Captures an active hold. Call it in the same transaction as the ledger posting for the
   * operation the hold protected.
   */
  async capture(tx: Executor, holdId: string, key: string): Promise<HoldResult> {
    const hold = await this.lock(tx, holdId);
    const decision = decideCapture(snapshot(hold), key);
    if (decision.kind === 'reject') throw this.rejection(hold, decision.reason);
    if (decision.kind === 'replay') return { hold, replayed: true };
    try {
      const ended = await this.holds.markCaptured(tx, hold.id, key, this.clock.now());
      return { hold: ended, replayed: false };
    } catch (error) {
      throw conflictIfKeyReused(error, 'holds_capture_key_key');
    }
  }
  /** Releases an active hold, returning its funds to the available balance. */
  async release(tx: Executor, holdId: string, key: string): Promise<HoldResult> {
    const hold = await this.lock(tx, holdId);
    const decision = decideRelease(snapshot(hold), key);
    if (decision.kind === 'reject') throw this.rejection(hold, decision.reason);
    if (decision.kind === 'replay') return { hold, replayed: true };
    try {
      const ended = await this.holds.markReleased(tx, hold.id, key, this.clock.now());
      return { hold: ended, replayed: false };
    } catch (error) {
      throw conflictIfKeyReused(error, 'holds_release_key_key');
    }
  }
  /** Looks a hold up by its public ref within a merchant and environment. */
  findByRef(merchantId: string, environment: LedgerEnvironment, ref: string) {
    return this.holds.findByRef(merchantId, environment, ref);
  }
  listActive(merchantId: string, environment: LedgerEnvironment, limit = 100) {
    return this.holds.listActive(merchantId, environment, limit);
  }
  /**
   * Expires active holds past `expires_at` (spec 6.7: every minute). Each hold ends in its
   * own short transaction under its row lock, so the sweep can overlap itself or run on two
   * nodes without a double effect, and one failure does not stop the rest.
   */
  async expireDue(limit = 200): Promise<HoldSweepResult> {
    const due = await this.holds.findDueForExpiry(this.clock.now(), limit);
    let expired = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of due) {
      try {
        const ended = await this.unitOfWork.run(async (tx) => {
          const hold = await this.holds.lockById(tx, id);
          const now = this.clock.now();
          if (
            !hold ||
            !isDueForExpiry({ state: hold.state as HoldState, expiresAt: hold.expiresAt }, now)
          ) {
            return false;
          }
          await this.holds.markExpired(tx, id, now);
          return true;
        });
        if (ended) expired += 1;
        else skipped += 1;
      } catch (error) {
        failed += 1;
        this.logger.error({ err: toLoggableError(error), holdId: id }, 'hold expiry failed');
      }
    }
    return { expired, skipped, failed };
  }
  private async lock(tx: Executor, holdId: string): Promise<HoldRow> {
    const hold = await this.holds.lockById(tx, holdId);
    if (!hold) throw new AppError('NOT_FOUND');
    return hold;
  }
  private rejection(hold: HoldRow, reason: string): AppError {
    return new AppError('HOLD_NOT_ACTIVE', {
      messageParams: { reason },
      details: { reason, state: hold.state },
    });
  }
  private validate(input: PlaceHoldInput): void {
    if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n)
      throw invalidHold('amount');
    if (!isSupportedCurrency(input.currency)) throw invalidHold('currency');
    if (input.reason.length < 1 || input.reason.length > 200) throw invalidHold('reason');
    if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) {
      throw invalidHold('idempotency_key');
    }
    if (!CREATED_BY.test(input.createdBy)) throw invalidHold('created_by');
    if (input.expiresAt && input.expiresAt <= this.clock.now()) throw invalidHold('expires_at');
  }
}
/** A capture or release key belongs to one hold; reusing it on another is a caller bug. */
function conflictIfKeyReused(error: unknown, constraint: string): unknown {
  return isUniqueViolation(error, constraint)
    ? new AppError('HOLD_CONFLICT', { cause: error })
    : error;
}
function snapshot(hold: HoldRow): HoldSnapshot {
  return {
    state: hold.state as HoldState,
    captureKey: hold.captureKey,
    releaseKey: hold.releaseKey,
  };
}
function sameRequest(existing: HoldRow, input: PlaceHoldInput): boolean {
  return (
    existing.merchantId === input.merchantId &&
    existing.environment === input.environment &&
    existing.currency === input.currency &&
    existing.amountMinor === input.amountMinor &&
    existing.reason === input.reason &&
    existing.transactionId === (input.transactionId ?? null)
  );
}
