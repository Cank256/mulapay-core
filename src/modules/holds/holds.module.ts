import { Module } from '@nestjs/common';
import { BalancesModule } from '../balances/balances.module';
import { HoldsRepository } from './holds.repository';
import { HoldsService } from './holds.service';
/** Holds against available balance (spec 6.7). */
@Module({
  imports: [BalancesModule],
  providers: [HoldsRepository, HoldsService],
  exports: [HoldsRepository, HoldsService],
})
export class HoldsModule {}
