/**
 * Root module of the `consumer` process: the gateway event consumer and scheduled jobs
 * (spec 4.1). The singleton advisory lock is taken in main.consumer.ts before this
 * module is built. Phase 0 runs no event loop; it arrives in Phase 3.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import type { Logger } from 'pino';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './common/db/database.module';
import { RedisModule } from './common/redis/redis.module';
import type { AppConfig } from './config/configuration';

@Module({})
export class ConsumerModule {
  static forRoot(config: AppConfig, logger: Logger): DynamicModule {
    return {
      module: ConsumerModule,
      imports: [CommonModule.forRoot(config, logger), DatabaseModule, RedisModule],
    };
  }
}
