// Must be first: validates config and starts tracing before instrumented modules load.
import './common/telemetry/register';
import { NestFactory } from '@nestjs/core';
import { runProcess } from './bootstrap/process';
import { startHealthServer } from './bootstrap/health-server';
import { DB_POOLS } from './common/db/tokens';
import type { DatabasePools } from './common/db/pools';
import { REDIS } from './common/redis/redis.module';
import type { Redis } from 'ioredis';

import { NestPinoLogger } from './common/logging/nest-logger';
import { WorkerModule } from './worker.module';

runProcess('worker', async ({ config, logger }) => {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, logger), {
    logger: new NestPinoLogger(logger),
    abortOnError: false,
  });
  app.enableShutdownHooks();
  await startHealthServer({
    port: config.HEALTH_PORT,
    host: config.HOST,
    logger,
    probes: [
      {
        name: 'database_rw',
        run: async () => {
          await app.get<DatabasePools>(DB_POOLS, { strict: false }).rw.query('select 1');
        },
      },
      {
        name: 'redis',
        run: async () => (await app.get<Redis>(REDIS, { strict: false }).ping()) === 'PONG',
      },
    ],
  });
  logger.info('core worker started');
});
