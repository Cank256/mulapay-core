/**
 * Roles and permissions (spec section 5.2 "roles / permissions"). Seeded by migration
 * 0001 and editable by admins. Merchant roles are the six fixed team roles from spec
 * 6.10; staff roles are listed in docs/SECURITY.md.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { core } from './core';
import { createdAt, updatedAt } from './columns';
import { users } from './identity';

export const roles = core.table(
  'roles',
  {
    key: text('key').primaryKey(),
    actorType: text('actor_type').notNull(),
    description: text('description').notNull(),
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('roles_actor_type_check', sql`${t.actorType} in ('staff', 'merchant')`)]
);

export const permissions = core.table(
  'permissions',
  {
    key: text('key').primaryKey(),
    actorType: text('actor_type').notNull(),
    description: text('description').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('permissions_actor_type_check', sql`${t.actorType} in ('staff', 'merchant')`),
    check('permissions_key_format_check', sql`${t.key} ~ '^[a-z_]+:[a-z_]+$'`),
  ]
);

export const rolePermissions = core.table(
  'role_permissions',
  {
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })]
);

/** Staff role assignments. Merchant users get their role from merchant_members. */
export const staffRoleAssignments = core.table(
  'staff_role_assignments',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key),
    grantedBy: uuid('granted_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleKey] }),
    index('staff_role_assignments_role_idx').on(t.roleKey),
  ]
);
