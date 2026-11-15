/**
 * Admin bootstrap (spec section 13 `npm run seed:admin`, Phase 1 deliverable).
 *
 * Creates a staff user with a random password and an enrolled TOTP secret, assigns a
 * staff role, and audits it as a `system` action. The password and the otpauth URI are
 * returned to the CLI once and never stored in plaintext. MFA is enrolled at creation
 * because staff cannot log in without it and the admin surface has no enrollment route.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PasswordHasher } from '../../common/auth/password-hasher';
import { TotpService } from '../../common/auth/totp.service';
import { AuditService } from '../../common/audit/audit.service';
import { STAFF_ROLES, type StaffRole } from '../../common/authz/permissions';
import type { Clock } from '../../common/clock/clock';
import { randomToken } from '../../common/crypto/crypto';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { RolesRepository } from '../identity/roles.repository';
import { UsersRepository } from '../identity/users.repository';
import { mfaSecretContext } from './mfa-secret';

export interface BootstrapAdminInput {
  readonly email: string;
  readonly name: string;
  readonly role?: StaffRole;
}

export interface BootstrappedAdmin {
  readonly userId: string;
  readonly email: string;
  readonly role: StaffRole;
  readonly password: string;
  readonly totpSecret: string;
  readonly otpauthUri: string;
}

export class AdminBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminBootstrapError';
  }
}

@Injectable()
export class AdminBootstrapService {
  constructor(
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly passwords: PasswordHasher,
    private readonly totp: TotpService,
    private readonly encryption: FieldEncryption,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async bootstrap(input: BootstrapAdminInput): Promise<BootstrappedAdmin> {
    const role = input.role ?? 'super_admin';
    if (!STAFF_ROLES.includes(role)) throw new AdminBootstrapError(`unknown staff role "${role}"`);
    if (!this.encryption.available) {
      throw new AdminBootstrapError('DATA_ENCRYPTION_KEY must be set to store the MFA secret');
    }
    if (await this.users.findByEmail(input.email)) {
      throw new AdminBootstrapError('a user with this email already exists');
    }
    const password = randomToken(18);
    const passwordHash = await this.passwords.hash(password);
    const totpSecret = this.totp.generateSecret();
    const now = this.clock.now();
    const id = uuidv7(now);
    const ref = publicId('user', now);
    await this.unitOfWork.run(async (tx) => {
      if (!(await this.roles.findRole(role, tx))) {
        throw new AdminBootstrapError(`role "${role}" is missing; run the migrations first`);
      }
      await this.users.insert(tx, {
        id,
        ref,
        type: 'staff',
        email: input.email,
        passwordHash,
        name: input.name,
        mfaEnabled: true,
        mfaSecretEnc: this.encryption.encrypt(totpSecret, mfaSecretContext(id)),
      });
      await this.roles.assignStaffRole(tx, id, role, null);
      await this.audit.record(tx, {
        action: 'staff.bootstrapped',
        resourceType: 'user',
        resourceId: ref,
        after: { email: input.email, name: input.name, type: 'staff', role, mfaEnabled: true },
        actor: { type: 'system', id: 'seed:admin', label: 'admin bootstrap script' },
      });
    });
    return {
      userId: ref,
      email: input.email,
      role,
      password,
      totpSecret,
      otpauthUri: this.totp.uri(input.email, totpSecret),
    };
  }
}
