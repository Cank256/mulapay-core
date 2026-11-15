import { Module } from '@nestjs/common';
import { TransactionsRepository } from './transactions.repository';
import { TransactionsService } from './transactions.service';

/** The transaction read model: queries and the registry of every money movement (spec 6.5). */
@Module({
  providers: [TransactionsRepository, TransactionsService],
  exports: [TransactionsRepository, TransactionsService],
})
export class TransactionsModule {}
