import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/configuration';
import { toLoggableError } from '../logging/redaction';
import { APP_CONFIG, ROOT_LOGGER } from '../tokens';
import { closeRedisClient, createRedisClient } from './redis.factory';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  onModuleInit(): void {
    // Not awaited: an unavailable Redis makes the process not-ready (readiness probe)
    // rather than failing boot. ioredis keeps reconnecting with backoff.
    this.redis.connect().catch((error: unknown) => {
      this.logger.warn({ err: toLoggableError(error) }, 'initial redis connection failed');
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedisClient(this.redis);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG, ROOT_LOGGER],
      useFactory: (config: AppConfig, logger: Logger) =>
        createRedisClient(config, 'commands', logger),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
