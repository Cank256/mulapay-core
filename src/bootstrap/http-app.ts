/**
 * Builds the API application with every cross-cutting concern applied. Used by
 * main.api.ts, the integration tests and the OpenAPI export, so all three exercise the
 * same configuration.
 */
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyServerOptions } from 'fastify';
import type { Logger } from 'pino';
import { AppModule, type AppModuleOptions } from '../app.module';
import { corsDelegator } from '../common/http/cors';
import { generateRequestId } from '../common/http/request-id';
import { registerRawBodyCapture } from '../common/http/raw-body';
import { registerRequestLogHook } from '../modules/developer/request-logs/request-log.hook';
import { RequestLogService } from '../modules/developer/request-logs/request-log.service';
import { registerRequestHooks } from '../common/http/request-hooks';
import { helmetOptions } from '../common/http/security-headers';
import { NestPinoLogger } from '../common/logging/nest-logger';
import { buildOpenApiDocuments, registerApiDocs } from '../common/openapi/openapi';
import type { AppConfig } from '../config/configuration';

/** requestId comes from the request-context mixin, not a child binding, so it is never duplicated. */
const childLoggerFactory: NonNullable<FastifyServerOptions['childLoggerFactory']> = (
  parent,
  _bindings,
  options
) => parent.child({}, options);

/** Spec section 9.2 rule 12. */
export const BODY_LIMIT_BYTES = 256 * 1024;

export function createFastifyAdapter(config: AppConfig, logger: Logger): FastifyAdapter {
  return new FastifyAdapter({
    loggerInstance: logger,
    // One completion line per request is written by request-hooks.ts instead.
    disableRequestLogging: true,
    childLoggerFactory,
    genReqId: generateRequestId,
    bodyLimit: BODY_LIMIT_BYTES,
    // Client IP is derived only from the configured proxy CIDRs (spec section 11).
    trustProxy: config.TRUST_PROXY.length > 0 ? [...config.TRUST_PROXY] : false,
    return503OnClosing: true,
  });
}

export async function createHttpApp(
  config: AppConfig,
  logger: Logger,
  options: AppModuleOptions = {}
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, logger, options),
    createFastifyAdapter(config, logger),
    // Nest's parsers are off: Fastify's own JSON parser (with prototype-poisoning protection)
    // is the only body parser. Every other content type is rejected with 415.
    { logger: new NestPinoLogger(logger), abortOnError: false, bodyParser: false }
  );

  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeContentTypeParser(['text/plain']);
  registerRawBodyCapture(fastify);
  registerRequestHooks(fastify, logger);
  // API request logging (spec 6.11): buffered in Redis, flushed by the worker.
  registerRequestLogHook(fastify, app.get(RequestLogService, { strict: false }));
  await app.register(helmet, helmetOptions);
  await app.register(cors, corsDelegator(config));
  // Unsigned cookies: the refresh token is itself an unguessable secret checked against
  // its hash, and the CSRF cookie is compared with a header (double submit).
  await app.register(cookie);

  if (config.ENABLE_API_DOCS) {
    await registerApiDocs(app, buildOpenApiDocuments(app));
  }

  app.enableShutdownHooks();
  return app;
}
