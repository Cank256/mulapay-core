/** SQL for `core.sessions`. One row per refresh token; see src/db/schema/identity.ts. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { sessions } from '../../db/schema';

export type SessionRow = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type RevokedReason =
  'rotated' | 'logout' | 'revoked_by_user' | 'reuse_detected' | 'user_disabled' | 'access_removed';

@Injectable()
export class SessionsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewSession): Promise<SessionRow> {
    const [row] = await tx.insert(sessions).values(values).returning();
    if (!row) throw new Error('session insert returned no row');
    return row;
  }

  /**
   * Atomically retires the live row holding `tokenHash`. Returns it, or undefined if the
   * token is unknown, already used, revoked or expired. Two concurrent refreshes with the
   * same token cannot both succeed.
   */
  async retireForRotation(tx: Executor, tokenHash: string, now: Date) {
    const [row] = await tx
      .update(sessions)
      .set({ revokedAt: now, revokedReason: 'rotated' })
      .where(
        and(
          eq(sessions.refreshTokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now)
        )
      )
      .returning();
    return row;
  }

  async findByTokenHash(tokenHash: string, tx: Executor = this.db) {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
      .limit(1);
    return row;
  }

  /** The live row of a session family, if the session is still active. */
  async findActiveByFamily(familyId: string, userId: string, now: Date, tx: Executor = this.db) {
    const [row] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.familyId, familyId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now)
        )
      )
      .limit(1);
    return row;
  }

  /** Revokes every live row of the family. Returns how many rows were revoked. */
  async revokeFamily(tx: Executor, familyId: string, reason: RevokedReason, now: Date) {
    const rows = await tx
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  async updateAuthTime(tx: Executor, id: string, authTime: Date, amr: string[], mfa: boolean) {
    await tx.update(sessions).set({ authTime, amr, mfa }).where(eq(sessions.id, id));
  }

  /** Active sessions of a user, newest first. Each family has at most one live row. */
  listActive(userId: string, surface: 'dashboard' | 'admin', now: Date) {
    return this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.surface, surface),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now)
        )
      )
      .orderBy(desc(sessions.createdAt))
      .limit(100);
  }
}
