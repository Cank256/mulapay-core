/** SQL for roles, permissions, role_permissions and staff_role_assignments. */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { permissions, rolePermissions, roles, staffRoleAssignments } from '../../db/schema';

export type RoleRow = typeof roles.$inferSelect;

@Injectable()
export class RolesRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  listRoles(tx: Executor = this.db) {
    return tx.select().from(roles).orderBy(asc(roles.actorType), asc(roles.key));
  }

  async findRole(key: string, tx: Executor = this.db): Promise<RoleRow | undefined> {
    const [row] = await tx.select().from(roles).where(eq(roles.key, key)).limit(1);
    return row;
  }

  /** Locks the role row so concurrent permission edits apply one after the other. */
  async lockRole(tx: Executor, key: string): Promise<RoleRow | undefined> {
    const [row] = await tx.select().from(roles).where(eq(roles.key, key)).for('update');
    return row;
  }

  listPermissions(tx: Executor = this.db) {
    return tx.select().from(permissions).orderBy(asc(permissions.key));
  }

  allRolePermissions(tx: Executor = this.db) {
    return tx
      .select({ roleKey: rolePermissions.roleKey, permissionKey: rolePermissions.permissionKey })
      .from(rolePermissions);
  }

  async replaceRolePermissions(tx: Executor, roleKey: string, permissionKeys: readonly string[]) {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleKey, roleKey));
    if (permissionKeys.length > 0) {
      await tx
        .insert(rolePermissions)
        .values(permissionKeys.map((permissionKey) => ({ roleKey, permissionKey })));
    }
  }

  async staffRoles(userId: string, tx: Executor = this.db): Promise<string[]> {
    const rows = await tx
      .select({ roleKey: staffRoleAssignments.roleKey })
      .from(staffRoleAssignments)
      .where(eq(staffRoleAssignments.userId, userId))
      .orderBy(asc(staffRoleAssignments.roleKey));
    return rows.map((r) => r.roleKey);
  }

  async assignStaffRole(tx: Executor, userId: string, roleKey: string, grantedBy: string | null) {
    await tx
      .insert(staffRoleAssignments)
      .values({ userId, roleKey, grantedBy })
      .onConflictDoNothing();
  }

  async staffWithRole(roleKey: string, tx: Executor = this.db) {
    return tx
      .select({ userId: staffRoleAssignments.userId })
      .from(staffRoleAssignments)
      .where(and(eq(staffRoleAssignments.roleKey, roleKey)));
  }
}
