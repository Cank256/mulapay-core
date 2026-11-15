/**
 * Prometheus metrics (spec section 10), `core_` prefix, one registry per process.
 *
 * Label values come from small fixed sets (surfaces, route templates, pool and queue
 * names) so request input cannot drive cardinality. Phase 0 defines the
 * infrastructure metrics and Phase 1 the auth failure counter; domain metrics are added by
 * the phase that owns them.
 *
 * Default Node.js process metrics are unprefixed, as in the gateway, so one dashboard
 * covers both services.
 */
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
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

/** Spec section 10. `reason` is one of a fixed set (see AuthGuard and the login flows). */
export const authFailures = new Counter({
  name: 'core_auth_failures_total',
  help: 'Authentication and authorization failures',
  labelNames: ['surface', 'reason'] as const,
  registers: [metricsRegistry],
});

/**
 * Spec section 10. `scope` is the idempotency operation (`payments.create`, ...), a fixed
 * set declared next to each `@Idempotent` route.
 */
export const idempotencyReplays = new Counter({
  name: 'core_idempotency_replays_total',
  help: 'Requests answered from a stored idempotent response',
  labelNames: ['scope'] as const,
  registers: [metricsRegistry],
});

/** Spec section 10. Incremented after the transition commits, never inside the transaction. */
export const transactionStateTransitions = new Counter({
  name: 'core_transaction_state_transitions_total',
  help: 'Transaction status changes',
  labelNames: ['type', 'from', 'to', 'source'] as const,
  registers: [metricsRegistry],
});

/**
 * Events that were refused (terminal state, invalid transition, amount mismatch, ...).
 * Not in the spec's list; each one is a reconciliation candidate, so it is worth alerting on.
 */
export const transactionEventRejections = new Counter({
  name: 'core_transaction_event_rejections_total',
  help: 'Transaction events refused by the state machine or by verification',
  labelNames: ['type', 'reason', 'source'] as const,
  registers: [metricsRegistry],
});
/** Spec section 10. `scope` is one of `key_read`, `key_write`, `merchant_payouts`, `key_burst`, `auth_failures`. */
export const rateLimitRejections = new Counter({
  name: 'core_rate_limit_rejections_total',
  help: 'Requests refused with 429',
  labelNames: ['scope'] as const,
  registers: [metricsRegistry],
});
/** Spec section 10. `outcome` is `success`, `http_error`, `timeout`, `network_error` or `blocked`. */
export const webhookDeliveryDuration = new Histogram({
  name: 'core_webhook_delivery_duration_seconds',
  help: 'Webhook delivery attempt duration',
  labelNames: ['outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});
export const webhookEndpointsAutoDisabled = new Counter({
  name: 'core_webhook_endpoints_auto_disabled_total',
  help: 'Webhook endpoints disabled after 50 consecutive failures',
  registers: [metricsRegistry],
});
/** Request log entries discarded because the Redis buffer was full. Not in the spec's list. */
export const apiRequestLogsDropped = new Counter({
  name: 'core_api_request_logs_dropped_total',
  help: 'API request log entries dropped because the buffer was full or unavailable',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});
/** Outbox rows that used all their attempts. Each one needs an operator (spec 8.8). */
export const outboxExhausted = new Counter({
  name: 'core_outbox_exhausted_total',
  help: 'Outbox rows that exhausted their attempts',
  labelNames: ['event_type'] as const,
  registers: [metricsRegistry],
});
