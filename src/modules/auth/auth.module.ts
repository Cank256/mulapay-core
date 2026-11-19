import { Module } from '@nestjs/common';
import { PRINCIPAL_RESOLVER } from '../../common/auth/principal';
import { NotificationsModule } from '../notifications/notifications.module';
import { IdentityModule } from '../identity/identity.module';
import { AuthService } from './auth.service';
import { EmailTokensRepository } from './email-tokens.repository';
import { EmailVerificationService } from './email-verification.service';
import { MfaChallengeStore } from './mfa-challenge.store';
import { MfaService } from './mfa.service';
import { PasswordResetService } from './password-reset.service';
import { DbPrincipalResolver } from './principal-resolver.service';
import { PrincipalRepository } from './principal.repository';
import { SessionService } from './session.service';

/**
 * Login, sessions, MFA, principal resolution, password reset and email verification for
 * the dashboard and admin surfaces. Sits above identity (users, sessions) and reads
 * memberships through its own repository so the merchants module does not depend on it.
 */
@Module({
  imports: [IdentityModule, NotificationsModule],
  providers: [
    PrincipalRepository,
    SessionService,
    AuthService,
    MfaService,
    MfaChallengeStore,
    DbPrincipalResolver,
    EmailTokensRepository,
    PasswordResetService,
    EmailVerificationService,
    { provide: PRINCIPAL_RESOLVER, useExisting: DbPrincipalResolver },
  ],
  exports: [
    AuthService,
    MfaService,
    SessionService,
    PasswordResetService,
    EmailVerificationService,
    PRINCIPAL_RESOLVER,
  ],
})
export class AuthModule {}
