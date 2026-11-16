import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { EventsModule } from '../events/events.module';
import { HoldsModule } from '../holds/holds.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { DisputesRepository } from './disputes.repository';
import { DisputesService } from './disputes.service';

/** Disputes and chargebacks (spec 6.14): holds on open, ledger on loss, release otherwise. */
@Module({
  imports: [BalancesModule, EventsModule, HoldsModule, LedgerModule, MerchantsModule],
  providers: [DisputesRepository, DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
