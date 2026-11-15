import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { BalancesModule } from '../balances/balances.module';
import { LedgerMerchantBalanceCheck } from '../balances/ledger-merchant-balance.check';
import { IdentityModule } from '../identity/identity.module';
import { InvitationsRepository } from './invitations.repository';
import { InvitationsService } from './invitations.service';
import { MERCHANT_BALANCE_CHECK } from './merchant-balance.check';
import { MembersRepository } from './members.repository';
import { MerchantsRepository } from './merchants.repository';
import { MerchantsService } from './merchants.service';
import { OnboardingService } from './onboarding.service';
import { TeamService } from './team.service';

/** Merchants, team membership, invitations and onboarding (spec 6.10). */
@Module({
  imports: [IdentityModule, AccountsModule, BalancesModule],
  providers: [
    MerchantsRepository,
    MembersRepository,
    InvitationsRepository,
    MerchantsService,
    InvitationsService,
    TeamService,
    OnboardingService,
    { provide: MERCHANT_BALANCE_CHECK, useExisting: LedgerMerchantBalanceCheck },
  ],
  exports: [
    MerchantsRepository,
    MembersRepository,
    MerchantsService,
    InvitationsService,
    TeamService,
    OnboardingService,
  ],
})
export class MerchantsModule {}
