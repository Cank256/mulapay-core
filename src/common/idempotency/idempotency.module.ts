import { Module } from '@nestjs/common';
import { IdempotencyMarker } from './idempotency-marker';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyService } from './idempotency.service';

/** Idempotent execution of creating and money-moving requests (spec 8.2). */
@Module({
  providers: [IdempotencyRepository, IdempotencyMarker, IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
