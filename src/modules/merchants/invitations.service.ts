/**
 * Team invitations (spec 5.2 `invitations`, 7.2 team and accept-invite).
 *
 * The invitation token is 32 random bytes; only its SHA-256 is stored. Until the
 * notification service exists (Phase 8) the token is returned once in the creation
 * response so the inviter can pass it on; see docs/ARCHITECTURE.md.
 *
 * Invariants:
 * - At most one pending invitation per (merchant, email); an expired one is revoked when
 *   a new one is issued.
 * - An `owner` invitation is only issued while the merchant has no owner, and the
 *   one-owner unique index rejects a second owner at acceptance.
 * - Accepting for an existing account requires that account's password, so a leaked
 *   token cannot attach someone else's account to a merchant.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PasswordHasher } from '../../common/auth/password-hasher';
import type { MerchantStatus } from '../../common/auth/principal';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantRole } from '../../common/authz/permissions';
import type { Clock } from '../../common/clock/clock';
import { randomToken, sha256Hex } from '../../common/crypto/crypto';
import type { Transaction } from '../../common/db/database.types';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { UsersRepository } from '../identity/users.repository';
import { merchantAllowsWrites } from './domain/merchant-lifecycle';
import { InvitationsRepository } from './invitations.repository';
import { MembersRepository } from './members.repository';
import {
  toInvitationView,
  type CreatedInvitationView,
  type InvitationView,
} from './merchant.views';
import { MerchantsRepository, type MerchantRow } from './merchants.repository';

export const INVITATION_TTL_DAYS = 7;

export interface AcceptInvitationInput {
  readonly token: string;
  readonly name?: string;
  readonly password: string;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly invitations: InvitationsRepository,
    private readonly members: MembersRepository,
    private readonly merchants: MerchantsRepository,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Dashboard: invite a team member to the caller's merchant. */
  async create(
    merchantId: string,
    input: { email: string; role: Exclude<MerchantRole, 'owner'> },
    actor: { userId: string }
  ): Promise<CreatedInvitationView> {
    return this.unitOfWork.run(async (tx) => {
      const merchant = await this.merchants.lockById(tx, merchantId);
      if (!merchant) throw new AppError('NOT_FOUND');
      return this.createInTx(tx, merchant, input, actor);
    });
  }

  /** Creates an invitation inside the caller's transaction. The merchant row is locked. */
  async createInTx(
    tx: Transaction,
    merchant: MerchantRow,
    input: { email: string; role: MerchantRole },
    actor: { userId: string }
  ): Promise<CreatedInvitationView> {
    const now = this.clock.now();
    if (input.role === 'owner' && (await this.members.findOwner(tx, merchant.id))) {
      throw new AppError('OWNER_PROTECTED');
    }
    const existingUser = await this.users.findByEmail(input.email, tx);
    if (existingUser) {
      const membership = await this.members.findByUser(tx, merchant.id, existingUser.id);
      if (membership?.status === 'active') throw new AppError('ALREADY_A_MEMBER');
    }
    const pending = await this.invitations.lockPendingByEmail(tx, merchant.id, input.email);
    if (pending) {
      if (pending.expiresAt.getTime() > now.getTime())
        throw new AppError('INVITATION_ALREADY_PENDING');
      await this.invitations.revoke(tx, merchant.id, pending.id, now);
    }
    const token = randomToken(32);
    const row = await this.invitations.insert(tx, {
      id: uuidv7(now),
      ref: publicId('invitation', now),
      merchantId: merchant.id,
      email: input.email,
      role: input.role,
      tokenHash: sha256Hex(token),
      invitedBy: actor.userId,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
    });
    await this.audit.record(tx, {
      action: 'invitation.created',
      resourceType: 'invitation',
      resourceId: row.ref,
      merchantId: merchant.id,
      after: { email: row.email, role: row.role, expiresAt: row.expiresAt },
    });
    return { ...toInvitationView(row, now), token };
  }

  async listPending(merchantId: string): Promise<InvitationView[]> {
    const now = this.clock.now();
    return (await this.invitations.listPending(merchantId)).map((r) => toInvitationView(r, now));
  }

  async revoke(merchantId: string, ref: string): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const row = await this.invitations.lockPendingByRef(tx, merchantId, ref);
      if (!row) throw new AppError('NOT_FOUND');
      await this.invitations.revoke(tx, merchantId, row.id, this.clock.now());
      await this.audit.record(tx, {
        action: 'invitation.revoked',
        resourceType: 'invitation',
        resourceId: row.ref,
        merchantId,
        before: { status: 'pending' },
        after: { status: 'revoked' },
      });
    });
  }

  /**
   * Accepts an invitation, creating the account when the email is new. Returns the
   * merchant ref and role. All failure modes of the token give one error.
   */
  async accept(
    input: AcceptInvitationInput
  ): Promise<{ merchantId: string; role: MerchantRole; userId: string }> {
    const tokenHash = sha256Hex(input.token);
    // Password work happens before the transaction so no row lock is held during argon2.
    const preview = await this.invitations.findByTokenHash(tokenHash);
    if (!preview) throw new AppError('INVITATION_INVALID');
    const existing = await this.users.findByEmail(preview.email);
    let newPasswordHash: string | undefined;
    if (existing) {
      const ok =
        existing.type === 'merchant_user' &&
        existing.status === 'active' &&
        (await this.passwords.verify(existing.passwordHash, input.password));
      if (!ok) throw new AppError('INVALID_CREDENTIALS');
    } else {
      if (!input.name) {
        throw new AppError('VALIDATION_FAILED', {
          details: {
            fields: [
              { path: 'name', code: 'required', message: 'name is required for a new account' },
            ],
          },
        });
      }
      newPasswordHash = await this.passwords.hash(input.password);
    }

    try {
      return await this.unitOfWork.run(async (tx) => {
        const now = this.clock.now();
        const invitation = await this.invitations.lockByTokenHash(tx, tokenHash);
        if (
          !invitation ||
          invitation.acceptedAt ||
          invitation.revokedAt ||
          invitation.expiresAt.getTime() <= now.getTime()
        ) {
          throw new AppError('INVITATION_INVALID');
        }
        const merchant = await this.merchants.lockById(tx, invitation.merchantId);
        if (!merchant || !merchantAllowsWrites(merchant.status as MerchantStatus)) {
          throw new AppError('INVITATION_INVALID');
        }
        const user =
          existing ??
          (await this.users.insert(tx, {
            id: uuidv7(now),
            ref: publicId('user', now),
            type: 'merchant_user',
            email: invitation.email,
            passwordHash: newPasswordHash ?? '',
            name: input.name ?? '',
          }));
        const actor = { type: 'user' as const, id: user.ref, label: user.name };
        if (!existing) {
          await this.audit.record(tx, {
            action: 'user.created',
            resourceType: 'user',
            resourceId: user.ref,
            after: { email: user.email, name: user.name, type: user.type },
            actor,
          });
        }
        const role = invitation.role as MerchantRole;
        const membership = await this.members.findByUser(tx, merchant.id, user.id);
        if (membership?.status === 'active') throw new AppError('ALREADY_A_MEMBER');
        if (membership) {
          await this.members.reactivate(
            tx,
            merchant.id,
            membership.id,
            role,
            invitation.invitedBy,
            now
          );
        } else {
          await this.members.insert(tx, {
            id: uuidv7(now),
            merchantId: merchant.id,
            userId: user.id,
            role,
            invitedBy: invitation.invitedBy,
            joinedAt: now,
          });
        }
        await this.invitations.accept(tx, invitation.id, user.id, now);
        await this.audit.record(tx, {
          action: 'invitation.accepted',
          resourceType: 'invitation',
          resourceId: invitation.ref,
          merchantId: merchant.id,
          before: { status: 'pending' },
          after: { status: 'accepted', userId: user.ref, role },
          actor,
        });
        return { merchantId: merchant.ref, role, userId: user.ref };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'merchant_members_one_owner_key'))
        throw new AppError('OWNER_PROTECTED');
      if (isUniqueViolation(error, 'users_email_key')) throw new AppError('INVITATION_INVALID');
      throw error;
    }
  }
}
