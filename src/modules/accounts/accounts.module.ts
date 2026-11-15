import { Module } from '@nestjs/common';
import { AccountsRepository } from './accounts.repository';
import { AccountsService } from './accounts.service';

/** Chart of accounts (spec 5.4): platform, provider, bank and merchant accounts. */
@Module({
  providers: [AccountsRepository, AccountsService],
  exports: [AccountsService, AccountsRepository],
})
export class AccountsModule {}
