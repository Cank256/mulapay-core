import { Module } from '@nestjs/common';
import { AmlModule } from '../aml/aml.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IncidentsRepository } from './incidents.repository';
import { IncidentsService } from './incidents.service';

/** Incidents: lifecycle, timeline, postmortems, the public status feed and automatic opening (spec 6.14). */
@Module({
  imports: [AmlModule, NotificationsModule],
  providers: [IncidentsRepository, IncidentsService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
