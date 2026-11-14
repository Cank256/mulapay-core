/**
 * `npm run openapi:export`: writes docs/openapi/{public,dashboard,admin}.json.
 *
 * Builds the application without initialising it, so no database or Redis connection is
 * opened. Requires a valid configuration (a `.env` or environment variables).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { createFastifyAdapter } from '../bootstrap/http-app';
import { createLogger } from '../common/logging/logger';
import { NestPinoLogger } from '../common/logging/nest-logger';
import { buildOpenApiDocuments } from '../common/openapi/openapi';
import { getConfig, loadDotEnv } from '../config/configuration';

async function main(): Promise<void> {
  loadDotEnv();
  const config = getConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: 'warn' });
  const app = await NestFactory.create(
    AppModule.forRoot(config, logger),
    createFastifyAdapter(config, logger),
    { logger: new NestPinoLogger(logger), abortOnError: false }
  );
  const documents = buildOpenApiDocuments(app);
  const outDir = join(process.cwd(), 'docs', 'openapi');
  mkdirSync(outDir, { recursive: true });
  for (const [surface, document] of Object.entries(documents)) {
    writeFileSync(join(outDir, `${surface}.json`), `${JSON.stringify(document, null, 2)}\n`);
  }
  logger.warn({ outDir, surfaces: Object.keys(documents) }, 'openapi documents written');
}

void main();
