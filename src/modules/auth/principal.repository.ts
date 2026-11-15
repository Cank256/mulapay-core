/**
 * Reads that join users, memberships and merchants to decide who an actor is. Used on
 * every authenticated dashboard request, so it is one indexed query.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { merchantMembers, merchants, users } from '../../db/schema';

const membershipColumns = {
  userId: users.id,
  userRef: users.ref,
  userType: users.type,
  userStatus: users.status,
  name: users.name,
  email: users.email,
  merchantId: merchants.id,
  merchantRef: merchants.ref,
  merchantStatus: merchants.status,
  role: merchantMembers.role,
};

export type MembershipRow = {
  userId: string;
  userRef: string;
  userType: string;
  userStatus: string;
  name: string;
  email: string;
  merchantId: string;
  merchantRef: string;
  merchantStatus: string;
  role: string;
};

@Injectable()
export class PrincipalRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  private async membership(
    where: SQL | undefined,
    tx: Executor
  ): Promise<MembershipRow | undefined> {
    const [row] = await tx
      .select(membershipColumns)
      .from(merchantMembers)
      .innerJoin(users, eq(users.id, merchantMembers.userId))
      .innerJoin(merchants, eq(merchants.id, merchantMembers.merchantId))
      .where(and(eq(merchantMembers.status, 'active'), where))
      .orderBy(asc(merchantMembers.joinedAt))
      .limit(1);
    return row;
  }

  /** Active membership of the user `userRef` in the merchant `merchantRef`. */
  byRefs(userRef: string, merchantRef: string, tx: Executor = this.db) {
    return this.membership(and(eq(users.ref, userRef), eq(merchants.ref, merchantRef)), tx);
  }

  byIds(userId: string, merchantId: string, tx: Executor = this.db) {
    return this.membership(and(eq(users.id, userId), eq(merchants.id, merchantId)), tx);
  }

  /** The membership a login binds to: the named merchant, else the earliest joined. */
  forLogin(userId: string, merchantRef: string | undefined, tx: Executor = this.db) {
    return this.membership(
      merchantRef
        ? and(eq(users.id, userId), eq(merchants.ref, merchantRef))
        : eq(users.id, userId),
      tx
    );
  }
}
