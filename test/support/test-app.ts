import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import pino from 'pino';
import type { AppModuleOptions } from '../../src/app.module';
import { createHttpApp } from '../../src/bootstrap/http-app';
import type { AppConfig } from '../../src/config/configuration';

/** The production HTTP application, initialised and ready for `app.inject()`. */
export async function createTestApp(
  config: AppConfig,
  options: AppModuleOptions & { logger?: Logger } = {}
): Promise<NestFastifyApplication> {
  const logger = options.logger ?? pino({ level: 'silent' });
  const app = await createHttpApp(config, logger, options);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
