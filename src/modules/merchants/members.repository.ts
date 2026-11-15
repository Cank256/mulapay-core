/**
 * SQL for `core.merchant_members`. Every method is scoped by `merchantId` (spec 8.4):
 * a member of one merchant can never be read or changed through another.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { MerchantRole } from '../../common/authz/permissions';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { merchantMembers, users } from '../../db/schema';

export type MemberRow = typeof merchantMembers.$inferSelect;

const memberWithUser = {
  memberId: merchantMembers.id,
  merchantId: merchantMembers.merchantId,
  userId: users.id,
  userRef: users.ref,
  name: users.name,
  email: users.email,
  role: merchantMembers.role,
  status: merchantMembers.status,
  joinedAt: merchantMembers.joinedAt,
  mfaEnabled: users.mfaEnabled,
};

export type MemberWithUser = {
  memberId: string;
  merchantId: string;
  userId: string;
  userRef: string;
  name: string;
  email: string;
  role: string;
  status: string;
  joinedAt: Date;
  mfaEnabled: boolean;
};

@Injectable()
export class MembersRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  /** Active members with their user, oldest first. */
  listActive(merchantId: string, tx: Executor = this.db): Promise<MemberWithUser[]> {
    return tx
      .select(memberWithUser)
      .from(merchantMembers)
      .innerJoin(users, eq(users.id, merchantMembers.userId))
      .where(and(eq(merchantMembers.merchantId, merchantId), eq(merchantMembers.status, 'active')))
      .orderBy(asc(merchantMembers.joinedAt), asc(users.ref))
      .limit(500);
  }

  /**
   * Locks the active membership of `userRef` in `merchantId` (the membership row only; the
   * user row is read without a lock). Postgres refuses `FOR UPDATE OF schema.table`, so
   * the lock is taken by a single-table query.
   */
  async lockActiveByUserRef(
    tx: Executor,
    merchantId: string,
    userRef: string
  ): Promise<MemberWithUser | undefined> {
    const [user] = await tx
      .select({
        id: users.id,
        ref: users.ref,
        name: users.name,
        email: users.email,
        mfaEnabled: users.mfaEnabled,
      })
      .from(users)
      .where(eq(users.ref, userRef))
      .limit(1);
    if (!user) return undefined;
    const [member] = await tx
      .select()
      .from(merchantMembers)
      .where(
        and(
          eq(merchantMembers.merchantId, merchantId),
          eq(merchantMembers.userId, user.id),
          eq(merchantMembers.status, 'active')
        )
      )
      .for('update');
    if (!member) return undefined;
    return {
      memberId: member.id,
      merchantId: member.merchantId,
      userId: user.id,
      userRef: user.ref,
      name: user.name,
      email: user.email,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt,
      mfaEnabled: user.mfaEnabled,
    };
  }

  async findByUser(
    tx: Executor,
    merchantId: string,
    userId: string
  ): Promise<MemberRow | undefined> {
    const [row] = await tx
      .select()
      .from(merchantMembers)
      .where(and(eq(merchantMembers.merchantId, merchantId), eq(merchantMembers.userId, userId)))
      .limit(1);
    return row;
  }

  async insert(tx: Executor, values: typeof merchantMembers.$inferInsert): Promise<MemberRow> {
    const [row] = await tx.insert(merchantMembers).values(values).returning();
    if (!row) throw new Error('member insert returned no row');
    return row;
  }

  /** Re-activates a previously removed membership with a new role. */
  async reactivate(
    tx: Executor,
    merchantId: string,
    memberId: string,
    role: MerchantRole,
    invitedBy: string | null,
    joinedAt: Date
  ) {
    await tx
      .update(merchantMembers)
      .set({ role, status: 'active', removedAt: null, invitedBy, joinedAt })
      .where(and(eq(merchantMembers.merchantId, merchantId), eq(merchantMembers.id, memberId)));
  }

  async setRole(tx: Executor, merchantId: string, memberId: string, role: MerchantRole) {
    await tx
      .update(merchantMembers)
      .set({ role })
      .where(and(eq(merchantMembers.merchantId, merchantId), eq(merchantMembers.id, memberId)));
  }

  async remove(tx: Executor, merchantId: string, memberId: string, at: Date) {
    await tx
      .update(merchantMembers)
      .set({ status: 'removed', removedAt: at })
      .where(and(eq(merchantMembers.merchantId, merchantId), eq(merchantMembers.id, memberId)));
  }

  /** Active owner of a merchant, if any. */
  async findOwner(tx: Executor, merchantId: string): Promise<MemberRow | undefined> {
    const [row] = await tx
      .select()
      .from(merchantMembers)
      .where(
        and(
          eq(merchantMembers.merchantId, merchantId),
          eq(merchantMembers.role, 'owner'),
          eq(merchantMembers.status, 'active')
        )
      )
      .limit(1);
    return row;
  }
}
