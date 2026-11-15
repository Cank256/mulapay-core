/**
 * Self-serve sign-up (`POST /dashboard/v1/auth/register`): creates the user, a `draft`
 * merchant and the owner membership in one transaction.
 *
 * Email verification needs the notification service (Phase 8); until then a registered
 * account is usable at once and a `draft` merchant is limited to test keys (KYC level 0).
 * An already registered email returns EMAIL_ALREADY_REGISTERED, which reveals that the
 * email exists; avoiding that needs email delivery (docs/ARCHITECTURE.md).
 */
import { Inject, Injectable } from '@nestjs/common';
import { PasswordHasher } from '../../common/auth/password-hasher';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { isUniqueViolation } from '../../common/db/pg-errors';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { AccountsService } from '../accounts/accounts.service';
import { UsersRepository } from '../identity/users.repository';
import { merchantAuditSnapshot, toMerchantView, type MerchantView } from './merchant.views';
import { MembersRepository } from './members.repository';
import { MerchantsRepository } from './merchants.repository';

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly merchant: {
    readonly legalName: string;
    readonly tradingName?: string;
    readonly country: string;
    readonly defaultCurrency: string;
  };
}

export interface Registration {
  readonly user: { id: string; email: string; name: string };
  readonly merchant: MerchantView;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly users: UsersRepository,
    private readonly merchants: MerchantsRepository,
    private readonly members: MembersRepository,
    private readonly passwords: PasswordHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async register(input: RegisterInput): Promise<Registration> {
    if (await this.users.findByEmail(input.email)) throw new AppError('EMAIL_ALREADY_REGISTERED');
    const passwordHash = await this.passwords.hash(input.password);
    try {
      return await this.unitOfWork.run(async (tx) => {
        const now = this.clock.now();
        const user = await this.users.insert(tx, {
          id: uuidv7(now),
          ref: publicId('user', now),
          type: 'merchant_user',
          email: input.email,
          passwordHash,
          name: input.name,
        });
        const merchant = await this.merchants.insert(tx, {
          id: uuidv7(now),
          ref: publicId('merchant', now),
          legalName: input.merchant.legalName,
          tradingName: input.merchant.tradingName ?? null,
          country: input.merchant.country,
          defaultCurrency: input.merchant.defaultCurrency,
          status: 'draft',
        });
        await this.accounts.openMerchantAccounts(tx, merchant);
        await this.members.insert(tx, {
          id: uuidv7(now),
          merchantId: merchant.id,
          userId: user.id,
          role: 'owner',
          joinedAt: now,
        });
        const actor = { type: 'user' as const, id: user.ref, label: user.name };
        await this.audit.record(tx, {
          action: 'user.registered',
          resourceType: 'user',
          resourceId: user.ref,
          after: { email: user.email, name: user.name, type: user.type },
          actor,
        });
        await this.audit.record(tx, {
          action: 'merchant.created',
          resourceType: 'merchant',
          resourceId: merchant.ref,
          merchantId: merchant.id,
          after: { ...merchantAuditSnapshot(merchant), owner: user.ref },
          actor,
        });
        return {
          user: { id: user.ref, email: user.email, name: user.name },
          merchant: toMerchantView(merchant),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key'))
        throw new AppError('EMAIL_ALREADY_REGISTERED');
      throw error;
    }
  }
}
