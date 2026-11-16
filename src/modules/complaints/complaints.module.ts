import { Module } from '@nestjs/common';
import { AmlModule } from '../aml/aml.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ComplaintsRepository } from './complaints.repository';
import { ComplaintsService } from './complaints.service';

/** Complaints with SLAs, message threads and breach detection (spec 6.14). */
@Module({
  imports: [AmlModule, MerchantsModule, NotificationsModule],
  providers: [ComplaintsRepository, ComplaintsService],
  exports: [ComplaintsService],
})
export class ComplaintsModule {}
