import { Module } from '@nestjs/common';
import { LifecycleRepository } from './lifecycle.repository';
import { LifecycleService } from './lifecycle.service';

/** Partition automation and retention (spec 5.1, 11). */
@Module({
  providers: [LifecycleRepository, LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
