// Must be first: validates config and starts tracing before instrumented modules load.
import './common/telemetry/register';
import { NestFactory } from '@nestjs/core';
import { runProcess } from './bootstrap/process';
import { tryAcquireSingletonLock } from './common/db/advisory-lock';
import { NestPinoLogger } from './common/logging/nest-logger';
import { ConsumerModule } from './consumer.module';
import { GATEWAY_CONSUMER_LOCK } from './consumers/gateway-events/constants';

runProcess('consumer', async ({ config, logger }) => {
  // Env validation guarantees DATABASE_DIRECT_URL for APP_ROLE=consumer.
  const connectionString = config.DATABASE_DIRECT_URL ?? '';
  const lock = await tryAcquireSingletonLock({
    connectionString,
    lockName: GATEWAY_CONSUMER_LOCK,
    applicationName: 'mulapay-core:consumer:lock',
    logger,
    onLost: () => {
      // Another consumer may now take the lock; stop immediately rather than risk two
      // instances applying events.
      logger.fatal('consumer lost its singleton lock; exiting');
      logger.flush();
      process.exit(1);
    },
  });
  if (!lock) {
    logger.error(
      { lock: GATEWAY_CONSUMER_LOCK },
      'another consumer holds the singleton lock; exiting'
    );
    logger.flush();
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(ConsumerModule.forRoot(config, logger), {
    logger: new NestPinoLogger(logger),
    abortOnError: false,
  });

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'consumer shutting down');
    void app
      .close()
      .then(() => lock.release())
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  logger.info(
    { lock: GATEWAY_CONSUMER_LOCK },
    'core consumer holds the singleton lock (event processing arrives in Phase 3)'
  );
});
