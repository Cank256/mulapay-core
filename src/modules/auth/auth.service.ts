/**
 * Login, MFA verification and step-up for the dashboard and admin surfaces (spec 8.3).
 *
 * Invariants:
 * - An unknown email, a wrong password, a disabled account and an account of the other
 *   surface's type all return INVALID_CREDENTIALS after the same argon2 work.
 * - Failures (passwords and MFA codes) feed the progressive lockout per account and IP.
 * - Staff always complete MFA (spec 4.2); a staff account without MFA cannot log in.
 * - A TOTP code is accepted at most once (time-step replay protection).
 * - Every success and every credential failure is audited.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AuthMethod } from '../../common/auth/access-token.service';
import { PasswordHasher } from '../../common/auth/password-hasher';
import type { UserPrincipal } from '../../common/auth/principal';
import { TotpService } from '../../common/auth/totp.service';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { authFailures } from '../../common/telemetry/metrics';
import { CLOCK } from '../../common/tokens';
import { LoginThrottle } from '../identity/login-throttle';
import { RolesRepository } from '../identity/roles.repository';
import { SessionsRepository } from '../identity/sessions.repository';
import { UsersRepository, type UserRow } from '../identity/users.repository';
import { MfaChallengeStore } from './mfa-challenge.store';
import { mfaSecretContext } from './mfa-secret';
import { PrincipalRepository } from './principal.repository';
import {
  SessionService,
  type AuthSurface,
  type ClientMeta,
  type SessionSubject,
  type TokenBundle,
} from './session.service';

export type LoginResult =
  | { readonly status: 'mfa_required'; readonly mfaToken: string; readonly expiresAt: Date }
  | {
      readonly status: 'authenticated';
      readonly tokens: TokenBundle;
      readonly subject: SessionSubject;
    };

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly sessionsRepo: SessionsRepository,
    private readonly principals: PrincipalRepository,
    private readonly sessions: SessionService,
    private readonly passwords: PasswordHasher,
    private readonly totp: TotpService,
    private readonly encryption: FieldEncryption,
    private readonly throttle: LoginThrottle,
    private readonly challenges: MfaChallengeStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async login(
    surface: AuthSurface,
    input: { email: string; password: string; merchant?: string },
    meta: ClientMeta
  ): Promise<LoginResult> {
    const user = await this.users.findByEmail(input.email);
    await this.throttle.assertNotLocked(input.email, meta.ip, user?.lockedUntil ?? null);
    const eligible = user && user.status === 'active' && user.type === expectedType(surface);
    const valid = eligible
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.verifyAgainstDummy(input.password);
    if (!valid || !user)
      return this.fail(
        surface,
        input.email,
        meta,
        eligible ? user : undefined,
        'auth.login_failed',
        'INVALID_CREDENTIALS'
      );

    const merchant = await this.bindMerchant(surface, user, input.merchant);
    if (surface === 'admin' && !user.mfaEnabled) {
      authFailures.inc({ surface, reason: 'mfa_enrollment_required' });
      throw new AppError('MFA_ENROLLMENT_REQUIRED');
    }
    if (user.mfaEnabled) {
      const mfaToken = await this.challenges.create({
        userId: user.id,
        surface,
        merchantId: merchant?.id ?? null,
      });
      return {
        status: 'mfa_required',
        mfaToken,
        expiresAt: new Date(this.clock.now().getTime() + 300_000),
      };
    }
    return this.complete(surface, user, merchant, ['pwd'], meta, input.email);
  }

  async verifyMfa(
    surface: AuthSurface,
    input: { mfaToken: string; code: string },
    meta: ClientMeta
  ): Promise<LoginResult> {
    const challenge = await this.challenges.get(input.mfaToken);
    if (!challenge || challenge.surface !== surface) throw new AppError('MFA_CHALLENGE_INVALID');
    const user = await this.users.findById(challenge.userId);
    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecretEnc) {
      throw new AppError('MFA_CHALLENGE_INVALID');
    }
    await this.throttle.assertNotLocked(user.email, meta.ip, user.lockedUntil);
    const step = await this.totp.verify(this.decryptSecret(user), input.code, user.mfaLastUsedStep);
    if (step === null) {
      await this.challenges.recordFailure(input.mfaToken, challenge);
      return this.fail(surface, user.email, meta, user, 'auth.mfa_failed', 'INVALID_MFA_CODE');
    }
    if (!(await this.challenges.consume(input.mfaToken)))
      throw new AppError('MFA_CHALLENGE_INVALID');
    const merchant =
      surface === 'dashboard' && challenge.merchantId
        ? await this.principals.byIds(user.id, challenge.merchantId)
        : undefined;
    if (surface === 'dashboard' && !merchant) throw new AppError('FORBIDDEN');
    return this.complete(
      surface,
      user,
      merchant ? { id: merchant.merchantId, ref: merchant.merchantRef, role: merchant.role } : null,
      ['pwd', 'otp'],
      meta,
      user.email,
      step
    );
  }

  /**
   * Re-authentication for sensitive actions (spec 8.3). Staff confirm with password and
   * TOTP. Returns a new access token whose `auth_time` is now.
   */
  async stepUp(
    principal: UserPrincipal,
    input: { password: string; code: string },
    meta: ClientMeta
  ) {
    const surface: AuthSurface = principal.kind === 'staff' ? 'admin' : 'dashboard';
    const user = await this.users.findById(principal.userId);
    if (!user) throw new AppError('UNAUTHORIZED');
    await this.throttle.assertNotLocked(user.email, meta.ip, user.lockedUntil);
    const passwordOk = await this.passwords.verify(user.passwordHash, input.password);
    const step =
      passwordOk && user.mfaSecretEnc
        ? await this.totp.verify(this.decryptSecret(user), input.code, user.mfaLastUsedStep)
        : null;
    if (step === null) {
      return this.fail(
        surface,
        user.email,
        meta,
        user,
        'auth.step_up_failed',
        'INVALID_CREDENTIALS'
      );
    }
    const now = this.clock.now();
    const session = await this.sessions.findActive(principal.sessionId, user.id);
    if (!session) throw new AppError('UNAUTHORIZED');
    const amr: AuthMethod[] = ['pwd', 'otp'];
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.users.consumeMfaStep(tx, user.id, step)))
        throw new AppError('INVALID_MFA_CODE');
      await this.sessionsRepo.updateAuthTime(tx, session.id, now, amr, true);
      await this.audit.record(tx, {
        action: 'auth.step_up',
        resourceType: 'session',
        resourceId: principal.sessionId,
      });
    });
    const roles = principal.kind === 'staff' ? principal.roles : [principal.role];
    return this.sessions.issueAccessToken(
      {
        user,
        surface,
        merchant: principal.kind === 'merchant_user' ? principal.merchant : null,
        roles,
        amr,
        mfa: true,
      },
      principal.sessionId,
      now
    );
  }

  logout(principal: UserPrincipal) {
    return this.sessions.revokeFamily(
      principal.sessionId,
      'logout',
      'auth.logout',
      merchantIdOf(principal)
    );
  }

  /** Revokes one of the principal's own sessions. Other users' sessions are NOT_FOUND. */
  async revokeSession(principal: UserPrincipal, sessionId: string): Promise<void> {
    const session = await this.sessions.findActive(sessionId, principal.userId);
    if (!session) throw new AppError('NOT_FOUND');
    await this.sessions.revokeFamily(
      sessionId,
      'revoked_by_user',
      'auth.session_revoked',
      merchantIdOf(principal)
    );
  }

  private async bindMerchant(surface: AuthSurface, user: UserRow, merchantRef: string | undefined) {
    if (surface !== 'dashboard') return null;
    const membership = await this.principals.forLogin(user.id, merchantRef);
    if (!membership) {
      authFailures.inc({ surface, reason: 'no_membership' });
      throw new AppError('FORBIDDEN');
    }
    return { id: membership.merchantId, ref: membership.merchantRef, role: membership.role };
  }

  private async complete(
    surface: AuthSurface,
    user: UserRow,
    merchant: { id: string; ref: string; role: string } | null,
    amr: AuthMethod[],
    meta: ClientMeta,
    email: string,
    mfaStep?: number
  ): Promise<LoginResult> {
    const roles =
      surface === 'admin' ? await this.roles.staffRoles(user.id) : merchant ? [merchant.role] : [];
    const subject: SessionSubject = {
      user,
      surface,
      merchant,
      roles,
      amr,
      mfa: amr.includes('otp'),
    };
    const tokens = await this.unitOfWork.run(async (tx) => {
      if (mfaStep !== undefined && !(await this.users.consumeMfaStep(tx, user.id, mfaStep))) {
        throw new AppError('INVALID_MFA_CODE');
      }
      await this.users.recordSuccessfulLogin(tx, user.id, this.clock.now());
      const bundle = await this.sessions.start(tx, subject, meta);
      await this.audit.record(tx, {
        action: 'auth.login_succeeded',
        resourceType: 'session',
        resourceId: bundle.sessionId,
        merchantId: merchant?.id ?? null,
        after: { surface, amr, mfa: subject.mfa },
        actor: { type: 'user', id: user.ref, label: user.name },
      });
      return bundle;
    });
    await this.throttle.recordSuccess(email);
    return { status: 'authenticated', tokens, subject };
  }

  /** Records a credential failure and throws `code`. */
  private async fail(
    surface: AuthSurface,
    email: string,
    meta: ClientMeta,
    user: UserRow | undefined,
    action: string,
    code: 'INVALID_CREDENTIALS' | 'INVALID_MFA_CODE'
  ): Promise<never> {
    const result = await this.throttle.recordFailure(email, meta.ip);
    authFailures.inc({
      surface,
      reason: code === 'INVALID_MFA_CODE' ? 'invalid_mfa_code' : 'invalid_credentials',
    });
    await this.unitOfWork.run(async (tx) => {
      if (user) {
        await this.users.recordFailedLogin(
          tx,
          user.id,
          result.accountFailures,
          result.accountLockedUntil ?? user.lockedUntil
        );
      }
      // The attempted email is not stored for unknown accounts (it may be anyone's PII).
      await this.audit.record(tx, {
        action,
        resourceType: 'user',
        resourceId: user?.ref ?? null,
        after: {
          surface,
          failures: result.accountFailures,
          locked: result.accountLockedUntil !== null,
        },
        outcome: 'denied',
        actor: { type: 'user', id: user?.ref ?? null, label: user?.name ?? null },
      });
    });
    throw new AppError(code);
  }

  private decryptSecret(user: UserRow): string {
    if (!user.mfaSecretEnc) throw new AppError('MFA_NOT_ENABLED');
    return this.encryption.decrypt(user.mfaSecretEnc, mfaSecretContext(user.id));
  }
}

function expectedType(surface: AuthSurface) {
  return surface === 'admin' ? 'staff' : 'merchant_user';
}

function merchantIdOf(principal: UserPrincipal): string | null {
  return principal.kind === 'merchant_user' ? principal.merchant.id : null;
}
