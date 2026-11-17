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

/** Phase 6: reconciliation and settlement (spec 10). Label values come from fixed sets. */
export const reconciliationExceptionsOpen = new Gauge({
  name: 'core_reconciliation_exceptions_open',
  help: 'Open and investigating reconciliation exceptions',
  labelNames: ['kind', 'severity'] as const,
  registers: [metricsRegistry],
});
export const ledgerIntegrityFailures = new Gauge({
  name: 'core_ledger_integrity_failures',
  help: 'Findings of the latest ledger integrity run, by kind',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});
export const suspenseBalanceMinor = new Gauge({
  name: 'core_suspense_balance_minor',
  help: 'Non-zero suspense balance found by the latest ledger integrity run',
  labelNames: ['currency'] as const,
  registers: [metricsRegistry],
});
export const reconciliationRunsTotal = new Counter({
  name: 'core_reconciliation_runs_total',
  help: 'Reconciliation runs finished, by kind and status',
  labelNames: ['kind', 'status'] as const,
  registers: [metricsRegistry],
});
export const settlementTransitionsTotal = new Counter({
  name: 'core_settlement_batch_transitions_total',
  help: 'Settlement batch status changes',
  labelNames: ['to'] as const,
  registers: [metricsRegistry],
});

/** Phase 7: compliance (spec 10). Label values come from fixed sets. */
export const amlAlertsOpen = new Gauge({
  name: 'core_aml_alerts_open',
  help: 'AML alerts that are open, investigating or escalated',
  labelNames: ['severity'] as const,
  registers: [metricsRegistry],
});
export const amlAlertSlaBreaches = new Counter({
  name: 'core_aml_alert_sla_breaches_total',
  help: 'AML alerts escalated because their SLA passed',
  labelNames: ['severity'] as const,
  registers: [metricsRegistry],
});
export const amlAlertsRaised = new Counter({
  name: 'core_aml_alerts_raised_total',
  help: 'AML alerts raised by monitoring rules',
  labelNames: ['rule_type', 'severity', 'action'] as const,
  registers: [metricsRegistry],
});
export const amlPrecheckDuration = new Histogram({
  name: 'core_aml_precheck_duration_seconds',
  help: 'Duration of the synchronous pre-transaction AML check',
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5],
  registers: [metricsRegistry],
});
export const amlPrecheckOutcomes = new Counter({
  name: 'core_aml_precheck_total',
  help: 'Pre-transaction AML checks by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});
export const kycDecisionsTotal = new Counter({
  name: 'core_kyc_decisions_total',
  help: 'KYC decisions by outcome',
  labelNames: ['decision'] as const,
  registers: [metricsRegistry],
});
export const amlScreeningsTotal = new Counter({
  name: 'core_aml_screenings_total',
  help: 'Sanctions and PEP screenings by result',
  labelNames: ['subject_type', 'status'] as const,
  registers: [metricsRegistry],
});

/** Phase 8: support and operations (spec 10). Label values come from fixed sets. */
export const complaintsOpen = new Gauge({
  name: 'core_complaints_open',
  help: 'Complaints that are not resolved or closed',
  labelNames: ['priority', 'breached'] as const,
  registers: [metricsRegistry],
});
export const complaintSlaBreaches = new Counter({
  name: 'core_complaint_sla_breaches_total',
  help: 'Complaints that passed their SLA deadline unresolved',
  labelNames: ['priority'] as const,
  registers: [metricsRegistry],
});
export const notificationsCreated = new Counter({
  name: 'core_notifications_created_total',
  help: 'Notifications created, by channel',
  labelNames: ['channel'] as const,
  registers: [metricsRegistry],
});
export const notificationsSuppressed = new Counter({
  name: 'core_notifications_suppressed_total',
  help: 'Notifications not created: deduplicated, no template, or a template that failed to render',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});
export const notificationDeliveries = new Counter({
  name: 'core_notification_deliveries_total',
  help: 'Notification delivery attempts by outcome (sent, rejected, retry, failed)',
  labelNames: ['channel', 'outcome', 'reason'] as const,
  registers: [metricsRegistry],
});
export const notificationDeliveriesBacklog = new Gauge({
  name: 'core_notification_deliveries_backlog',
  help: 'Deliveries from the last day that are pending or failed',
  labelNames: ['channel', 'status'] as const,
  registers: [metricsRegistry],
});
export const reportsFinished = new Counter({
  name: 'core_reports_total',
  help: 'Reports by type and outcome (ready, failed, expired)',
  labelNames: ['type', 'outcome'] as const,
  registers: [metricsRegistry],
});
export const reportDuration = new Histogram({
  name: 'core_report_generation_duration_seconds',
  help: 'Time to stream a report from the database into object storage',
  labelNames: ['type'] as const,
  buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
  registers: [metricsRegistry],
});
export const incidentsOpened = new Counter({
  name: 'core_incidents_opened_total',
  help: 'Incidents opened, by severity and source',
  labelNames: ['severity', 'source'] as const,
  registers: [metricsRegistry],
});
export const opsSignalsActive = new Gauge({
  name: 'core_ops_signals_active',
  help: '1 while an automatic incident monitor sees its condition',
  labelNames: ['signal'] as const,
  registers: [metricsRegistry],
});
export const transactionsStuck = new Gauge({
  name: 'core_transactions_stuck',
  help: 'Transactions in processing past the stuck threshold, by age bucket',
  labelNames: ['type', 'age_bucket'] as const,
  registers: [metricsRegistry],
});
export const approvalsPending = new Gauge({
  name: 'core_approvals_pending',
  help: 'Operational approvals waiting for a second person',
  registers: [metricsRegistry],
});
export const maintenanceModeGauge = new Gauge({
  name: 'core_maintenance_mode',
  help: '1 while maintenance mode is on',
  registers: [metricsRegistry],
});
export const maintenanceRejections = new Counter({
  name: 'core_maintenance_rejections_total',
  help: 'Writes refused with 503 because maintenance mode is on',
  registers: [metricsRegistry],
});
export const rollupRuns = new Counter({
  name: 'core_rollup_runs_total',
  help: 'Dashboard rollup runs by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});
export const opsActions = new Counter({
  name: 'core_ops_actions_total',
  help: 'Operational actions taken by staff',
  labelNames: ['action'] as const,
  registers: [metricsRegistry],
});

export const ledgerPostingDuration = new Histogram({
  name: 'core_ledger_posting_duration_seconds',
  help: 'Time to post one ledger entry (validate, lock balances, insert), including replays and refusals; the spec 9.1 target is p99 under 25 ms for six lines',
  labelNames: ['source'] as const,
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});
export const partitionMonthsAhead = new Gauge({
  name: 'core_partition_months_ahead',
  help: 'Whole months of partitions that exist after the current one, per partitioned table (alert below 2)',
  labelNames: ['table'] as const,
  registers: [metricsRegistry],
});
export const partitionDefaultHasRows = new Gauge({
  name: 'core_partition_default_has_rows',
  help: '1 while a default partition holds rows, which means a month had no partition when it was written (alert above 0)',
  labelNames: ['table'] as const,
  registers: [metricsRegistry],
});
export const partitionsDropped = new Counter({
  name: 'core_partitions_dropped_total',
  help: 'Expired partitions dropped by the retention job',
  labelNames: ['table'] as const,
  registers: [metricsRegistry],
});
export const partitionsRetentionBlocked = new Counter({
  name: 'core_partitions_retention_blocked_total',
  help: 'Expired partitions the retention job kept, by reason',
  labelNames: ['table', 'reason'] as const,
  registers: [metricsRegistry],
});
export const retentionRowsDeleted = new Counter({
  name: 'core_retention_rows_deleted_total',
  help: 'Rows removed by the batched retention clean-ups (idempotency keys, published outbox rows)',
  labelNames: ['target'] as const,
  registers: [metricsRegistry],
});
export const lifecycleRuns = new Counter({
  name: 'core_data_lifecycle_runs_total',
  help: 'Partition maintenance and retention runs by outcome',
  labelNames: ['job', 'outcome'] as const,
  registers: [metricsRegistry],
});
/**
 * Functions that bring a gauge up to date from shared state. `MetricsService` runs them on
 * every scrape, as it does for pool and queue gauges, so the api process reports what the
 * worker's runs found. Keyed by name: registering twice replaces, never duplicates.
 */
export const metricRefreshers = new Map<string, () => Promise<void>>();
