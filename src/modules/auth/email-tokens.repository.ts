/** SQL for `core.email_tokens` — single-use tokens for password reset and email verification. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { emailTokens } from '../../db/schema';

export type EmailTokenKind = 'password_reset' | 'email_verification';
export type EmailTokenRow = typeof emailTokens.$inferSelect;

@Injectable()
export class EmailTokensRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(
    tx: Executor,
    values: typeof emailTokens.$inferInsert
  ): Promise<EmailTokenRow> {
    const [row] = await tx.insert(emailTokens).values(values).returning();
    if (!row) throw new Error('email_token insert returned no row');
    return row;
  }

  /**
   * Finds a valid (unused, unexpired) token by its hash.
   * Two concurrent requests using the same hash cannot both "find" it as valid because
   * `consumeToken` atomically marks it used.
   */
  async findValid(
    tokenHash: string,
    kind: EmailTokenKind,
    now: Date,
    tx: Executor = this.db
  ): Promise<EmailTokenRow | undefined> {
    const [row] = await tx
      .select()
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.tokenHash, tokenHash),
          eq(emailTokens.kind, kind),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, now)
        )
      )
      .limit(1);
    return row;
  }

  /**
   * Atomically marks one token as used. Returns `true` if it was consumed (i.e. it was still
   * valid); `false` if a concurrent request already consumed it.
   */
  async consume(tx: Executor, id: string, now: Date): Promise<boolean> {
    const rows = await tx
      .update(emailTokens)
      .set({ usedAt: now })
      .where(and(eq(emailTokens.id, id), isNull(emailTokens.usedAt)))
      .returning({ id: emailTokens.id });
    return rows.length === 1;
  }

  /** Invalidates all unused tokens of `kind` for a user (before issuing a fresh one). */
  async revokeAllForUser(
    tx: Executor,
    userId: string,
    kind: EmailTokenKind,
    now: Date
  ): Promise<void> {
    await tx
      .update(emailTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.kind, kind),
          isNull(emailTokens.usedAt)
        )
      );
  }
}
