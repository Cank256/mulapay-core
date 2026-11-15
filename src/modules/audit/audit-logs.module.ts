import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/merchants.module';
import { AuditLogsRepository } from './audit-logs.repository';
import { AuditLogsService } from './audit-logs.service';

/** Admin reads of the audit log and chain verification. Writing is common/audit. */
@Module({
  imports: [MerchantsModule],
  providers: [AuditLogsRepository, AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
