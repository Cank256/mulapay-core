// Must be first: validates config and starts tracing before instrumented modules load.
import './common/telemetry/register';
import { NestFactory } from '@nestjs/core';
import { runProcess } from './bootstrap/process';
import { NestPinoLogger } from './common/logging/nest-logger';
import { WorkerModule } from './worker.module';

runProcess('worker', async ({ config, logger }) => {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, logger), {
    logger: new NestPinoLogger(logger),
    abortOnError: false,
  });
  app.enableShutdownHooks();
  logger.info('core worker started');
});
