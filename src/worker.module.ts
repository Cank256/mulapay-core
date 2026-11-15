/** Root module of the `worker` process: BullMQ workers, no HTTP listener (spec 4.1). */
import { Module, type DynamicModule } from '@nestjs/common';
import type { Logger } from 'pino';
import { CommonModule } from './common/common.module';
import { AuditModule } from './common/audit/audit.module';
import { AuthCoreModule } from './common/auth/auth-core.module';
import { DatabaseModule } from './common/db/database.module';
import { QueueModule } from './common/queue/queue.module';
import { WorkerHost } from './common/queue/worker-host';
import { RedisModule } from './common/redis/redis.module';
import type { AppConfig } from './config/configuration';
import { JobsModule } from './jobs/jobs.module';

@Module({})
export class WorkerModule {
  /** `schedules: false` boots the workers without the repeating jobs (tests only). */
  static forRoot(
    config: AppConfig,
    logger: Logger,
    options: { readonly schedules: boolean } = { schedules: true }
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        CommonModule.forRoot(config, logger),
        DatabaseModule,
        RedisModule,
        QueueModule,
        AuditModule,
        AuthCoreModule,
        JobsModule.register(options),
      ],
      providers: [WorkerHost],
    };
  }
}
