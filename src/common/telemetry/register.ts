/**
 * Side-effect import that must be the first import of every entry point: loads `.env`,
 * validates configuration (exiting on failure) and starts tracing before any instrumented
 * module is loaded.
 */
import { getConfig, loadDotEnv } from '../../config/configuration';
import { startTracing } from './tracing';

loadDotEnv();
startTracing(getConfig());
