import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { EventsModule } from '../events/events.module';
import { HoldsRepository } from './holds.repository';
import { HoldsService } from './holds.service';
/** Holds against available balance (spec 6.7). */
@Module({
  imports: [BalancesModule, EventsModule],
  providers: [HoldsRepository, HoldsService],
  exports: [HoldsRepository, HoldsService],
})
export class HoldsModule {}
