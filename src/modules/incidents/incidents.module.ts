import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { IncidentsRepository } from './incidents.repository';
import { IncidentsService } from './incidents.service';

@Module({
  imports: [AuditModule],
  providers: [IncidentsRepository, IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
