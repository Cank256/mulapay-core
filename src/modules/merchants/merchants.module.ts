import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { InvitationsRepository } from './invitations.repository';
import { InvitationsService } from './invitations.service';
import { MERCHANT_BALANCE_CHECK, NoLedgerYetBalanceCheck } from './merchant-balance.check';
import { MembersRepository } from './members.repository';
import { MerchantsRepository } from './merchants.repository';
import { MerchantsService } from './merchants.service';
import { OnboardingService } from './onboarding.service';
import { TeamService } from './team.service';

/** Merchants, team membership, invitations and onboarding (spec 6.10). */
@Module({
  imports: [IdentityModule],
  providers: [
    MerchantsRepository,
    MembersRepository,
    InvitationsRepository,
    MerchantsService,
    InvitationsService,
    TeamService,
    OnboardingService,
    { provide: MERCHANT_BALANCE_CHECK, useClass: NoLedgerYetBalanceCheck },
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
