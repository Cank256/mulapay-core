/** SQL for `core.users`. */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { users } from '../../db/schema';

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserType = 'staff' | 'merchant_user';

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async findByEmail(email: string, tx: Executor = this.db): Promise<UserRow | undefined> {
    const [row] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    return row;
  }

  async findById(id: string, tx: Executor = this.db): Promise<UserRow | undefined> {
    const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }

  async findByRef(ref: string, tx: Executor = this.db): Promise<UserRow | undefined> {
    const [row] = await tx.select().from(users).where(eq(users.ref, ref)).limit(1);
    return row;
  }

  /** Locks the row for the rest of the transaction. */
  async lockById(tx: Executor, id: string): Promise<UserRow | undefined> {
    const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update');
    return row;
  }

  async insert(tx: Executor, values: NewUser): Promise<UserRow> {
    const [row] = await tx.insert(users).values(values).returning();
    if (!row) throw new Error('user insert returned no row');
    return row;
  }

  async recordFailedLogin(tx: Executor, id: string, count: number, lockedUntil: Date | null) {
    await tx.update(users).set({ failedLoginCount: count, lockedUntil }).where(eq(users.id, id));
  }

  async recordSuccessfulLogin(tx: Executor, id: string, at: Date) {
    await tx
      .update(users)
      .set({ lastLoginAt: at, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, id));
  }

  /** Stores a pending (not yet enabled) MFA secret. No-op if MFA is already enabled. */
  async setPendingMfaSecret(tx: Executor, id: string, secretEnc: string): Promise<boolean> {
    const rows = await tx
      .update(users)
      .set({ mfaSecretEnc: secretEnc, mfaLastUsedStep: null })
      .where(and(eq(users.id, id), eq(users.mfaEnabled, false)))
      .returning({ id: users.id });
    return rows.length === 1;
  }

  async enableMfa(tx: Executor, id: string, timeStep: number) {
    await tx
      .update(users)
      .set({ mfaEnabled: true, mfaLastUsedStep: timeStep })
      .where(eq(users.id, id));
  }

  async disableMfa(tx: Executor, id: string) {
    await tx
      .update(users)
      .set({ mfaEnabled: false, mfaSecretEnc: null, mfaLastUsedStep: null })
      .where(eq(users.id, id));
  }

  /**
   * Records an accepted TOTP step. Returns false if a concurrent request already used this
   * or a later step, so one code can never authenticate twice.
   */
  async consumeMfaStep(tx: Executor, id: string, timeStep: number): Promise<boolean> {
    const rows = await tx
      .update(users)
      .set({ mfaLastUsedStep: timeStep })
      .where(
        and(
          eq(users.id, id),
          or(isNull(users.mfaLastUsedStep), lt(users.mfaLastUsedStep, timeStep))
        )
      )
      .returning({ id: users.id });
    return rows.length === 1;
  }
}
