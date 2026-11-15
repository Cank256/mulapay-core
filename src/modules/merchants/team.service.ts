/**
 * Team membership changes (spec 6.10 and 7.2 team routes).
 *
 * Invariants (each refused with OWNER_PROTECTED):
 * - Only the owner transfers ownership, and only to another active member. The transfer
 *   demotes the old owner to `admin` and promotes the target in one transaction; the
 *   one-owner unique index guarantees there is never a second owner.
 * - The owner's role cannot be changed and the owner cannot be removed, by anyone. The
 *   owner must transfer ownership first.
 *
 * Membership is re-read on every request (PrincipalResolver), so a removal or role change
 * takes effect on the member's next request without waiting for their token to expire.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { MerchantRole } from '../../common/authz/permissions';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { CLOCK } from '../../common/tokens';
import { toMemberView, type MemberView } from './merchant.views';
import { MembersRepository, type MemberWithUser } from './members.repository';
import { MerchantsRepository } from './merchants.repository';

export interface TeamActor {
  readonly userId: string;
  readonly userRef: string;
  readonly role: MerchantRole;
}

@Injectable()
export class TeamService {
  constructor(
    private readonly members: MembersRepository,
    private readonly merchants: MerchantsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async list(merchantId: string): Promise<MemberView[]> {
    return (await this.members.listActive(merchantId)).map(toMemberView);
  }

  /** Admin view of a merchant's team, by merchant ref. */
  async listByMerchantRef(merchantRef: string): Promise<MemberView[]> {
    const merchant = await this.merchants.findByRef(merchantRef);
    if (!merchant) throw new AppError('NOT_FOUND');
    return this.list(merchant.id);
  }

  async changeRole(
    merchantId: string,
    actor: TeamActor,
    targetUserRef: string,
    role: MerchantRole
  ): Promise<MemberView> {
    return this.unitOfWork.run(async (tx) => {
      const target = await this.lockTarget(tx, merchantId, targetUserRef);
      if (role === 'owner') return this.transferOwnership(tx, merchantId, actor, target);
      if (target.role === 'owner') throw new AppError('OWNER_PROTECTED');
      if (target.role === role) return toMemberView(target);
      await this.members.setRole(tx, merchantId, target.memberId, role);
      await this.audit.record(tx, {
        action: 'merchant_member.role_changed',
        resourceType: 'merchant_member',
        resourceId: target.userRef,
        merchantId,
        before: { role: target.role },
        after: { role },
      });
      return toMemberView({ ...target, role });
    });
  }

  async remove(merchantId: string, targetUserRef: string): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const target = await this.lockTarget(tx, merchantId, targetUserRef);
      if (target.role === 'owner') throw new AppError('OWNER_PROTECTED');
      await this.members.remove(tx, merchantId, target.memberId, this.clock.now());
      await this.audit.record(tx, {
        action: 'merchant_member.removed',
        resourceType: 'merchant_member',
        resourceId: target.userRef,
        merchantId,
        before: { role: target.role, status: 'active' },
        after: { status: 'removed' },
      });
    });
  }

  private async transferOwnership(
    tx: Transaction,
    merchantId: string,
    actor: TeamActor,
    target: MemberWithUser
  ): Promise<MemberView> {
    if (actor.role !== 'owner' || target.userRef === actor.userRef) {
      throw new AppError('OWNER_PROTECTED');
    }
    const current = await this.lockTarget(tx, merchantId, actor.userRef);
    if (current.role !== 'owner') throw new AppError('OWNER_PROTECTED');
    // Demote first: the one-owner index refuses two active owners even mid-transaction.
    await this.members.setRole(tx, merchantId, current.memberId, 'admin');
    await this.members.setRole(tx, merchantId, target.memberId, 'owner');
    await this.audit.record(tx, {
      action: 'merchant.ownership_transferred',
      resourceType: 'merchant_member',
      resourceId: target.userRef,
      merchantId,
      before: { owner: current.userRef, targetRole: target.role },
      after: { owner: target.userRef, previousOwnerRole: 'admin' },
    });
    return toMemberView({ ...target, role: 'owner' });
  }

  private async lockTarget(tx: Transaction, merchantId: string, userRef: string) {
    const target = await this.members.lockActiveByUserRef(tx, merchantId, userRef);
    if (!target) throw new AppError('NOT_FOUND');
    return target;
  }
}
