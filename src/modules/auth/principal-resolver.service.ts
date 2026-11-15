/**
 * Turns verified access-token claims into a live principal (spec 8.4).
 *
 * The token proves who the caller was at issue; this lookup decides what they may do now:
 * a disabled user, a removed membership or a changed role takes effect on the next
 * request. Permissions come from the database role grants, not from the token.
 */
import { Injectable } from '@nestjs/common';
import type { AccessTokenClaims } from '../../common/auth/access-token.service';
import type { MerchantStatus, PrincipalResolver, UserPrincipal } from '../../common/auth/principal';
import { merchantUserAbility, staffAbility } from '../../common/authz/ability';
import type { MerchantRole } from '../../common/authz/permissions';
import { RolePermissionsService } from '../identity/role-permissions.service';
import { RolesRepository } from '../identity/roles.repository';
import { UsersRepository } from '../identity/users.repository';
import { PrincipalRepository } from './principal.repository';

@Injectable()
export class DbPrincipalResolver implements PrincipalResolver {
  constructor(
    private readonly principals: PrincipalRepository,
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly rolePermissions: RolePermissionsService
  ) {}

  async resolve(claims: AccessTokenClaims): Promise<UserPrincipal | null> {
    const common = {
      sessionId: claims.sid,
      mfa: claims.mfa,
      amr: claims.amr,
      authTime: new Date(claims.auth_time * 1000),
    };
    if (claims.type === 'staff') {
      const user = await this.users.findByRef(claims.sub);
      if (user?.type !== 'staff' || user.status !== 'active') return null;
      const roles = await this.roles.staffRoles(user.id);
      return {
        kind: 'staff',
        ...common,
        userId: user.id,
        userRef: user.ref,
        name: user.name,
        email: user.email,
        roles,
        ability: staffAbility(await this.rolePermissions.permissionsFor(roles)),
      };
    }
    if (!claims.merchantId) return null;
    const row = await this.principals.byRefs(claims.sub, claims.merchantId);
    if (!row || row.userStatus !== 'active' || row.userType !== 'merchant_user') return null;
    return {
      kind: 'merchant_user',
      ...common,
      userId: row.userId,
      userRef: row.userRef,
      name: row.name,
      email: row.email,
      merchant: {
        id: row.merchantId,
        ref: row.merchantRef,
        status: row.merchantStatus as MerchantStatus,
      },
      role: row.role as MerchantRole,
      ability: merchantUserAbility(await this.rolePermissions.permissionsFor([row.role])),
    };
  }
}
