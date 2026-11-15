import { Module } from '@nestjs/common';
import { RequestLogBuffer } from './request-logs/request-log.buffer';
import { RequestLogRepository } from './request-logs/request-log.repository';
import { RequestLogService } from './request-logs/request-log.service';

/**
 * Developer platform pieces shared by the api and worker processes: API request logging.
 * The sandbox simulator has its own module (`SandboxModule`, worker only) because it
 * depends on the payment lifecycle.
 */
@Module({
  providers: [RequestLogBuffer, RequestLogRepository, RequestLogService],
  exports: [RequestLogBuffer, RequestLogRepository, RequestLogService],
})
export class DeveloperModule {}
