/**
 * Prometheus metrics (spec section 10), `core_` prefix, one registry per process.
 *
 * Label values come from small fixed sets (surfaces, route templates, pool and queue
 * names) so request input cannot drive cardinality. Phase 0 defines only the
 * infrastructure metrics; domain metrics are added by the phase that owns them.
 *
 * Default Node.js process metrics are unprefixed, as in the gateway, so one dashboard
 * covers both services.
 */
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { SERVICE_NAME } from '../../config/configuration';

export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: SERVICE_NAME });
collectDefaultMetrics({ register: metricsRegistry });

export function setMetricsRole(role: string): void {
  metricsRegistry.setDefaultLabels({ service: SERVICE_NAME, role });
}

export const httpRequestDuration = new Histogram({
  name: 'core_http_request_duration_seconds',
  help: 'Inbound HTTP request duration',
  labelNames: ['surface', 'method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const dbPoolConnections = new Gauge({
  name: 'core_db_pool_connections',
  help: 'Database pool clients by state',
  labelNames: ['pool', 'state'] as const,
  registers: [metricsRegistry],
});

export const queueDepth = new Gauge({
  name: 'core_queue_depth',
  help: 'Jobs waiting, prioritized or delayed per queue',
  labelNames: ['queue'] as const,
  registers: [metricsRegistry],
});

export const queueOldestJobSeconds = new Gauge({
  name: 'core_queue_oldest_job_seconds',
  help: 'Age of the oldest waiting job per queue',
  labelNames: ['queue'] as const,
  registers: [metricsRegistry],
});
