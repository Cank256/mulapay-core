import { Module } from '@nestjs/common';
import { LoginThrottle } from './login-throttle';
import { RolePermissionsService } from './role-permissions.service';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';
import { SessionsRepository } from './sessions.repository';
import { UsersRepository } from './users.repository';

/** Users, sessions, roles and permissions, and login protection. */
@Module({
  providers: [
    UsersRepository,
    SessionsRepository,
    RolesRepository,
    RolePermissionsService,
    RolesService,
    LoginThrottle,
  ],
  exports: [
    UsersRepository,
    SessionsRepository,
    RolesRepository,
    RolePermissionsService,
    RolesService,
    LoginThrottle,
  ],
})
export class IdentityModule {}
