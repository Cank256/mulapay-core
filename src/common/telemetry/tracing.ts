/**
 * OpenTelemetry tracing over OTLP/HTTP (spec section 10).
 *
 * Starts only when ENABLE_TELEMETRY=true, and must run before http, pg, ioredis and undici
 * are loaded so they can be patched; each entry point imports ./register first.
 *
 * Instrumented: inbound and outbound HTTP (including undici calls to the gateway, which
 * propagates `traceparent`), Postgres and Redis. SQL parameters and Redis arguments are
 * never recorded. BullMQ spans come from bullmq-otel on the queue and worker options.
 *
 * Sampling is head-based at TELEMETRY_SAMPLE_RATIO. "Errors always sampled" needs
 * tail-based sampling in the collector; see docs/ARCHITECTURE.md.
 */
import type { IncomingMessage } from 'node:http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import { SERVICE_NAME, type AppConfig } from '../../config/configuration';
import { SanitizingSpanExporter } from './span-sanitizer';

let sdk: NodeSDK | undefined;

/** Probes would otherwise dominate trace volume. */
const UNTRACED_PATHS = new Set(['/v1/health', '/v1/health/ready', '/metrics']);

/** TELEMETRY_ENDPOINT may be a bare collector address; OTLP/HTTP traces live at /v1/traces. */
export function resolveTracesUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/v1/traces';
  }
  return url.toString();
}

type TracingConfig = Pick<
  AppConfig,
  'ENABLE_TELEMETRY' | 'TELEMETRY_ENDPOINT' | 'TELEMETRY_SAMPLE_RATIO' | 'APP_ROLE' | 'NODE_ENV'
>;

export function startTracing(config: TracingConfig): boolean {
  if (sdk || !config.ENABLE_TELEMETRY || !config.TELEMETRY_ENDPOINT) {
    return false;
  }
  const exporter = new SanitizingSpanExporter(
    new OTLPTraceExporter({ url: resolveTracesUrl(config.TELEMETRY_ENDPOINT) })
  );
  sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    resource: resourceFromAttributes({
      'service.namespace': 'mulapay',
      'deployment.environment.name': config.NODE_ENV,
      'mulapay.role': config.APP_ROLE,
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.TELEMETRY_SAMPLE_RATIO),
    }),
    spanProcessors: [new BatchSpanProcessor({ exporter })],
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req: IncomingMessage) =>
          UNTRACED_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
      }),
      new UndiciInstrumentation(),
      // enhancedDatabaseReporting stays off: SQL parameters are never recorded
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      // Record the command name only; arguments hold keys and cached values
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
    ],
  });
  sdk.start();
  return true;
}

/** Flushes pending spans. Call after the process has stopped accepting work. */
export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } finally {
    sdk = undefined;
  }
}
