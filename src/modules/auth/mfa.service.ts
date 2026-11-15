/**
 * MFA enrollment for merchant users (spec 7.2 `auth/mfa/enroll`, `auth/mfa/disable`).
 *
 * Enrollment is two calls to the same route: without a code it stores a new pending
 * secret (encrypted, bound to the user id) and returns it with an `otpauth://` URI; with
 * a code it verifies the pending secret and enables MFA. The secret is never audited or
 * logged. Disabling needs step-up (route decorator) and a current code.
 *
 * Staff MFA is set up by the admin bootstrap; the admin surface has no enrollment route.
 */
import { Injectable } from '@nestjs/common';
import type { UserPrincipal } from '../../common/auth/principal';
import { TotpService } from '../../common/auth/totp.service';
import { AuditService } from '../../common/audit/audit.service';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { UsersRepository, type UserRow } from '../identity/users.repository';
import { mfaSecretContext } from './mfa-secret';

export type EnrollResult =
  | { readonly status: 'pending'; readonly secret: string; readonly otpauthUri: string }
  | { readonly status: 'enabled' };

@Injectable()
export class MfaService {
  constructor(
    private readonly users: UsersRepository,
    private readonly totp: TotpService,
    private readonly encryption: FieldEncryption,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService
  ) {}

  async enroll(principal: UserPrincipal, code: string | undefined): Promise<EnrollResult> {
    const user = await this.loadUser(principal);
    if (user.mfaEnabled) throw new AppError('MFA_ALREADY_ENABLED');
    return code === undefined ? this.start(user) : this.confirm(user, code);
  }

  async disable(principal: UserPrincipal, code: string): Promise<void> {
    const user = await this.loadUser(principal);
    if (!user.mfaEnabled || !user.mfaSecretEnc) throw new AppError('MFA_NOT_ENABLED');
    const secret = this.encryption.decrypt(user.mfaSecretEnc, mfaSecretContext(user.id));
    const step = await this.totp.verify(secret, code, user.mfaLastUsedStep);
    if (step === null) throw new AppError('INVALID_MFA_CODE');
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.users.consumeMfaStep(tx, user.id, step)))
        throw new AppError('INVALID_MFA_CODE');
      await this.users.disableMfa(tx, user.id);
      await this.audit.record(tx, {
        action: 'auth.mfa_disabled',
        resourceType: 'user',
        resourceId: user.ref,
        before: { mfaEnabled: true },
        after: { mfaEnabled: false },
      });
    });
  }

  private async start(user: UserRow): Promise<EnrollResult> {
    const secret = this.totp.generateSecret();
    const encrypted = this.encryption.encrypt(secret, mfaSecretContext(user.id));
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.users.setPendingMfaSecret(tx, user.id, encrypted))) {
        throw new AppError('MFA_ALREADY_ENABLED');
      }
      await this.audit.record(tx, {
        action: 'auth.mfa_enrollment_started',
        resourceType: 'user',
        resourceId: user.ref,
      });
    });
    return { status: 'pending', secret, otpauthUri: this.totp.uri(user.email, secret) };
  }

  private async confirm(user: UserRow, code: string): Promise<EnrollResult> {
    if (!user.mfaSecretEnc) throw new AppError('MFA_ENROLLMENT_NOT_STARTED');
    const secret = this.encryption.decrypt(user.mfaSecretEnc, mfaSecretContext(user.id));
    const step = await this.totp.verify(secret, code, null);
    if (step === null) throw new AppError('INVALID_MFA_CODE');
    await this.unitOfWork.run(async (tx) => {
      await this.users.enableMfa(tx, user.id, step);
      await this.audit.record(tx, {
        action: 'auth.mfa_enabled',
        resourceType: 'user',
        resourceId: user.ref,
        before: { mfaEnabled: false },
        after: { mfaEnabled: true },
      });
    });
    return { status: 'enabled' };
  }

  private async loadUser(principal: UserPrincipal): Promise<UserRow> {
    const user = await this.users.findById(principal.userId);
    if (!user) throw new AppError('UNAUTHORIZED');
    return user;
  }
}
