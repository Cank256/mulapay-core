import { Module } from '@nestjs/common';
import { PRINCIPAL_RESOLVER } from '../../common/auth/principal';
import { IdentityModule } from '../identity/identity.module';
import { AuthService } from './auth.service';
import { MfaChallengeStore } from './mfa-challenge.store';
import { MfaService } from './mfa.service';
import { DbPrincipalResolver } from './principal-resolver.service';
import { PrincipalRepository } from './principal.repository';
import { SessionService } from './session.service';

/**
 * Login, sessions, MFA and principal resolution for the dashboard and admin surfaces.
 * Sits above identity (users, sessions) and reads memberships through its own
 * repository, so the merchants module does not depend on it.
 */
@Module({
  imports: [IdentityModule],
  providers: [
    PrincipalRepository,
    SessionService,
    AuthService,
    MfaService,
    MfaChallengeStore,
    DbPrincipalResolver,
    { provide: PRINCIPAL_RESOLVER, useExisting: DbPrincipalResolver },
  ],
  exports: [AuthService, MfaService, SessionService, PRINCIPAL_RESOLVER],
})
export class AuthModule {}
