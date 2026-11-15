/**
 * Role administration (spec 5.2: roles and permissions are seeded and editable by admin).
 *
 * Invariants:
 * - A role only receives permissions of its own actor type (also enforced by a trigger).
 * - `super_admin` always keeps `roles:manage`, so no edit can lock every admin out of
 *   role management.
 * - The set of roles is fixed; only their permissions change.
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { RolePermissionsService } from './role-permissions.service';
import { RolesRepository } from './roles.repository';

export interface RoleView {
  readonly key: string;
  readonly actorType: 'staff' | 'merchant';
  readonly description: string;
  readonly permissions: string[];
}

export const PROTECTED_GRANT = { role: 'super_admin', permission: 'roles:manage' } as const;

@Injectable()
export class RolesService {
  constructor(
    private readonly roles: RolesRepository,
    private readonly rolePermissions: RolePermissionsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService
  ) {}

  async list(): Promise<{
    roles: RoleView[];
    permissions: { key: string; actorType: string; description: string }[];
  }> {
    const [roleRows, grants, permissionRows] = await Promise.all([
      this.roles.listRoles(),
      this.roles.allRolePermissions(),
      this.roles.listPermissions(),
    ]);
    const byRole = new Map<string, string[]>();
    for (const grant of grants) {
      byRole.set(grant.roleKey, [...(byRole.get(grant.roleKey) ?? []), grant.permissionKey]);
    }
    return {
      roles: roleRows.map((role) => ({
        key: role.key,
        actorType: role.actorType as RoleView['actorType'],
        description: role.description,
        permissions: (byRole.get(role.key) ?? []).sort(),
      })),
      permissions: permissionRows.map((p) => ({
        key: p.key,
        actorType: p.actorType,
        description: p.description,
      })),
    };
  }

  /** Replaces a role's permissions. Audited with the before and after sets. */
  async setPermissions(roleKey: string, requested: readonly string[]): Promise<RoleView> {
    const permissionKeys = [...new Set(requested)].sort();
    const view = await this.unitOfWork.run(async (tx) => {
      const role = await this.roles.lockRole(tx, roleKey);
      if (!role) throw new AppError('NOT_FOUND');
      const known = new Map(
        (await this.roles.listPermissions(tx)).map((p) => [p.key, p.actorType])
      );
      for (const key of permissionKeys) {
        if (known.get(key) !== role.actorType) {
          throw new AppError('ROLE_UPDATE_REJECTED', {
            messageParams: { reason: `${key} is not a ${role.actorType} permission` },
          });
        }
      }
      if (
        roleKey === PROTECTED_GRANT.role &&
        !permissionKeys.includes(PROTECTED_GRANT.permission)
      ) {
        throw new AppError('ROLE_UPDATE_REJECTED', {
          messageParams: { reason: 'super_admin must keep roles:manage' },
        });
      }
      const before = (await this.roles.allRolePermissions(tx))
        .filter((g) => g.roleKey === roleKey)
        .map((g) => g.permissionKey)
        .sort();
      await this.roles.replaceRolePermissions(tx, roleKey, permissionKeys);
      await this.audit.record(tx, {
        action: 'role.permissions_updated',
        resourceType: 'role',
        resourceId: roleKey,
        before: { permissions: before },
        after: { permissions: permissionKeys },
      });
      return {
        key: role.key,
        actorType: role.actorType as RoleView['actorType'],
        description: role.description,
        permissions: permissionKeys,
      };
    });
    await this.rolePermissions.invalidateAll();
    return view;
  }
}
