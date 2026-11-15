/** SQL for `core.invitations`. Scoped by `merchantId` except lookup by token hash. */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { invitations } from '../../db/schema';

export type InvitationRow = typeof invitations.$inferSelect;

@Injectable()
export class InvitationsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: typeof invitations.$inferInsert): Promise<InvitationRow> {
    const [row] = await tx.insert(invitations).values(values).returning();
    if (!row) throw new Error('invitation insert returned no row');
    return row;
  }

  /** Pending (not accepted, not revoked) invitations, newest first. Includes expired ones. */
  listPending(merchantId: string) {
    return this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.merchantId, merchantId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt)
        )
      )
      .orderBy(desc(invitations.createdAt))
      .limit(200);
  }

  async lockPendingByRef(tx: Executor, merchantId: string, ref: string) {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.merchantId, merchantId),
          eq(invitations.ref, ref),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt)
        )
      )
      .for('update');
    return row;
  }

  async lockPendingByEmail(tx: Executor, merchantId: string, email: string) {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.merchantId, merchantId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt)
        )
      )
      .for('update');
    return row;
  }

  async findByTokenHash(tokenHash: string) {
    const [row] = await this.db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .limit(1);
    return row;
  }

  /** The invitation a raw token belongs to, locked. Unscoped: the token is the credential. */
  async lockByTokenHash(tx: Executor, tokenHash: string) {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .for('update');
    return row;
  }

  async revoke(tx: Executor, merchantId: string, id: string, at: Date) {
    await tx
      .update(invitations)
      .set({ revokedAt: at })
      .where(and(eq(invitations.merchantId, merchantId), eq(invitations.id, id)));
  }

  async accept(tx: Executor, id: string, userId: string, at: Date) {
    await tx
      .update(invitations)
      .set({ acceptedAt: at, acceptedBy: userId })
      .where(eq(invitations.id, id));
  }
}
