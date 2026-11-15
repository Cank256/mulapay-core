import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { BalancesModule } from '../balances/balances.module';
import { LedgerIntegrityRepository } from './ledger-integrity.repository';
import { LedgerIntegrityService } from './ledger-integrity.service';
import { LedgerRepository } from './ledger.repository';
import { PostingService } from './posting.service';
import { ReversalService } from './reversal.service';

/**
 * The double-entry ledger (spec 5.3, 6.6, decision D5): posting, reversal and integrity
 * validation. `PostingService.postEntry` is the only write path into the journal.
 */
@Module({
  imports: [AccountsModule, BalancesModule],
  providers: [
    LedgerRepository,
    LedgerIntegrityRepository,
    PostingService,
    ReversalService,
    LedgerIntegrityService,
  ],
  exports: [PostingService, ReversalService, LedgerIntegrityService],
})
export class LedgerModule {}
