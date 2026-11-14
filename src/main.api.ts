// Must be first: validates config and starts tracing before instrumented modules load.
import './common/telemetry/register';
import { createHttpApp } from './bootstrap/http-app';
import { runProcess } from './bootstrap/process';

runProcess('api', async ({ config, logger }) => {
  const app = await createHttpApp(config, logger);
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, docs: config.ENABLE_API_DOCS }, 'core api listening');
});
