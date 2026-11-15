import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { BalancesRepository } from './balances.repository';
import { BalancesService } from './balances.service';
import { LedgerMerchantBalanceCheck } from './ledger-merchant-balance.check';

/** Posted balances per (account, currency) (spec 6.7). Written only by ledger postings. */
@Module({
  imports: [AccountsModule],
  providers: [BalancesRepository, BalancesService, LedgerMerchantBalanceCheck],
  exports: [BalancesRepository, BalancesService, LedgerMerchantBalanceCheck],
})
export class BalancesModule {}
