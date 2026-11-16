import { Module } from '@nestjs/common';
import { RollupsRepository } from './rollups.repository';
import { RollupsService } from './rollups.service';

/** Daily merchant rollups and the analytics that read them (spec 5.2, 9.2 rule 4). */
@Module({
  providers: [RollupsRepository, RollupsService],
  exports: [RollupsService],
})
export class RollupsModule {}
