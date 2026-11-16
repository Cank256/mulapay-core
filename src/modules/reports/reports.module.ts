import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportGenerationService } from './report-generation.service';
import { ReportSchedulesService } from './report-schedules.service';
import { ReportRequestedHandler } from './report.handlers';
import { ReportStreamRepository } from './report-stream.repository';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/** Asynchronous reports, their schedules and their expiry (spec 6.12). */
@Module({
  imports: [MerchantsModule, NotificationsModule, OutboxModule, StorageModule],
  providers: [
    ReportsRepository,
    ReportStreamRepository,
    ReportsService,
    ReportGenerationService,
    ReportSchedulesService,
    ReportRequestedHandler,
  ],
  exports: [
    ReportsService,
    ReportSchedulesService,
    ReportGenerationService,
    ReportRequestedHandler,
  ],
})
export class ReportsModule {}
