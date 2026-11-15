/** SQL for `core.idempotency_keys` (spec 8.2). */
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { MerchantScope } from '../auth/merchant-scope';
import type { Executor } from '../db/database.types';
import { idempotencyKeys } from '../../db/schema';

export type IdempotencyRow = typeof idempotencyKeys.$inferSelect;

export interface ClaimInput {
  readonly id: string;
  readonly scope: MerchantScope;
  readonly operation: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly now: Date;
  readonly expiresAt: Date;
}

@Injectable()
export class IdempotencyRepository {
  /**
   * Inserts an `in_flight` row for the key. If the key exists and has expired, its row is
   * recycled for this request (one statement, so two requests cannot both recycle it). If the
   * key exists and is still live, nothing changes and undefined is returned. If another
   * transaction has an uncommitted row for the key, this statement waits for it (bounded by
   * `lock_timeout`) and then sees its outcome.
   */
  async claim(tx: Executor, input: ClaimInput): Promise<IdempotencyRow | undefined> {
    const [row] = await tx
      .insert(idempotencyKeys)
      .values({
        id: input.id,
        merchantId: input.scope.merchantId,
        environment: input.scope.environment,
        scope: input.operation,
        key: input.key,
        requestFingerprint: input.fingerprint,
        status: 'in_flight',
        lockedAt: input.now,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          idempotencyKeys.merchantId,
          idempotencyKeys.environment,
          idempotencyKeys.scope,
          idempotencyKeys.key,
        ],
        set: {
          requestFingerprint: input.fingerprint,
          status: 'in_flight',
          responseStatus: sql`null`,
          responseBody: sql`null`,
          lockedAt: input.now,
          expiresAt: input.expiresAt,
        },
        setWhere: sql`${idempotencyKeys.expiresAt} <= ${input.now}`,
      })
      .returning();
    return row;
  }

  async find(
    tx: Executor,
    scope: MerchantScope,
    operation: string,
    key: string
  ): Promise<IdempotencyRow | undefined> {
    const [row] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.merchantId, scope.merchantId),
          eq(idempotencyKeys.environment, scope.environment),
          eq(idempotencyKeys.scope, operation),
          eq(idempotencyKeys.key, key)
        )
      )
      .limit(1);
    return row;
  }

  async complete(tx: Executor, id: string, statusCode: number, body: unknown): Promise<void> {
    await tx
      .update(idempotencyKeys)
      .set({ status: 'completed', responseStatus: statusCode, responseBody: body })
      .where(eq(idempotencyKeys.id, id));
  }
}
