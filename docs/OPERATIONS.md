# Operations

Runbooks for what can fail in production (spec 13, 16). Phase 5 covers the developer platform:
the outbox, webhooks, API request logs and API keys. Later phases add the rest (stuck
transaction, consumer lag, ledger mismatch, suspense balance, failed settlement).

Metrics are at `GET /metrics` (bearer `METRICS_TOKEN`). Queues are under the Redis prefix
`QUEUE_PREFIX` (default `mulapay-core`).

## Webhook backlog

**Symptoms.** `core_queue_depth{queue="webhook-delivery"}` or its oldest-job age grows; merchants
report late webhooks; `core_webhook_delivery_duration_seconds` shows a slow tail; webhook failure
rate above 20%.

1. Is the **worker** running? Webhook delivery, the outbox and the sandbox all run only in the
   worker (`APP_ROLE=worker`). No worker, no deliveries, and the API keeps accepting requests.
2. Is the **outbox** draining? `select count(*), min(created_at) from core.outbox where
published_at is null and attempts < 10;` should be near zero and young. Rows with
   `attempts >= 10` are stuck (`last_error` says why; `core_outbox_exhausted_total`). A row is
   only claimed by a dispatcher that has a handler for its `event_type`, so an old worker after a
   deploy leaves new event types untouched.
3. Are deliveries pending? `select status, count(*) from core.webhook_deliveries where
created_at > now() - interval '2 days' group by 1;`. Pending deliveries whose
   `next_attempt_at` passed more than a minute ago are re-queued by the recovery sweep on every
   outbox tick; if they stay, the `webhook-delivery` workers are down or saturated (concurrency
   32).
4. One merchant's endpoint failing is not a platform problem: it retries on its schedule (30 s,
   2 m, 10 m, 1 h, 6 h, 24 h) and is auto-disabled after 50 consecutive failures. The merchant is
   told through a `webhook_endpoint.auto_disabled` event and the audit trail. Re-enabling is
   `PATCH /v1/webhook-endpoints/:ref {"status":"active"}` or the dashboard.
5. Redis down: deliveries stop being queued, but nothing is lost. Rows stay in Postgres (outbox,
   deliveries); the recovery sweep re-queues them when Redis returns.

**Replaying** after an incident: `POST /dashboard/v1/webhook-deliveries/replay` with the event
type and date range, at most 500 per call; repeat until `truncated` is false. Receivers deduplicate
on `MulaPay-Event-Id`.

## Outbox rows that exhausted their attempts

`select id, event_type, aggregate_id, attempts, last_error from core.outbox where published_at
is null and attempts >= 10;` Fix the cause (missing handler version, a poison row, a database
fault), then `update core.outbox set attempts = 0, available_at = now(), locked_at = null where
id = ...`. Handlers are idempotent, so re-running one is safe. The announcements of money
movements must not be deleted: a missing `merchant_event.created` row means a merchant never gets
that webhook.

## Compromised API key

1. Revoke it: dashboard `DELETE /dashboard/v1/api-keys/:id`, or (support) the same through an
   owner. It stops working on every server at once; the cache entry is evicted through a Redis
   marker. If Redis was unreachable at that moment the key is revoked in Postgres and cached
   copies lapse within 60 seconds: check the `api key cache eviction failed` log line.
2. Roll instead if the integration must continue: `POST .../roll` with `gracePeriodHours: 0`.
3. Read the key's activity: `GET /dashboard/v1/request-logs` (filter by time; each entry names
   the key and the client address) and the audit trail. A live key with `payouts:write` also
   needed the signing secret: if that leaked too, rolling replaces both.
4. If the merchant itself is compromised, suspend it (`POST /admin/v1/merchants/:ref/suspend`):
   this evicts all of its keys from the cache and live payments are refused with
   `MERCHANT_NOT_ACTIVE`.
5. Rotate webhook secrets if the endpoint secret leaked:
   `POST /v1/webhook-endpoints/:ref/rotate-secret` with `graceHours: 0`.

**Never** change `api_keys`, `merchants.status` or `webhook_endpoints` by hand in production
without evicting the cache (`ApiKeyCache.evict`/`evictMerchant`): a cached key keeps its old
state for up to 60 seconds.

## API request log buffer

Entries sit in the Redis list `apilog:buffer` until the worker flushes them (every 2 s, batches
of 500). If the list keeps growing (`llen apilog:buffer`), the worker or the database is down. At
200,000 entries new ones are dropped (`core_api_request_logs_dropped_total{reason="buffer_full"}`)
so logging can never take the API down. Batches a dead worker held are finished by the next flush
after 30 seconds; inserts are idempotent. Logs are kept 90 days: drop the partition, never
`DELETE` (the table is append-only).

## Rate limits and signatures

- `core_rate_limit_rejections_total{scope}` shows which limit is refusing. `auth_failures` is
  the per-client failed-authentication limit: a spike usually means a merchant with a wrong key in a
  retry loop (their address gets `429` for a minute) or a scan.
- With Redis down, writes get `503` (the rate limit and replay protection cannot be checked) and
  reads continue.
- A merchant reporting `SIGNATURE_REPLAYED`: two identical requests were signed in the same
  second. They must sign each attempt again, at least a second later.
- `SIGNATURE_TIMESTAMP_INVALID`: their clock is more than 300 s from ours; check NTP.

## Sandbox

Test payments are resolved by the worker (queue `gateway-chase`, job `sandbox.step`). A test
payment stuck in `created` means the worker or the outbox is not running. `timeout` payments
stay `processing` for `SANDBOX_TIMEOUT_RESOLVE_SECONDS` on purpose.

## Compliance (Phase 7)

- **AML rules ship disabled.** Nothing is monitored until Compliance reviews each seeded rule's
  thresholds (`POST /admin/v1/aml/rules`, then enable). Limits per level are placeholders too.
- **Queue `aml-screen`** runs screenings, post-transaction monitoring (`aml.monitor-transaction`),
  the SLA and escalation tick (every minute), the blocklist mirror rebuild (every 5 minutes) and the
  KYC expiry and re-verification sweep (hourly). Jobs retry 8 times from 10 s. A screening that
  exhausts its retries sits in the dead-letter set: the merchant stays unscreened and cannot activate.
  Fix the provider (`SANCTIONS_BASE_URL`), then retry the job; a duplicate has no second effect.
- **Pre-transaction check and Redis.** With Redis down, payment creation returns `503` and writes
  nothing (fail closed). The blocklist is mirrored in Redis from Postgres; if it looks wrong, wait for
  the 5-minute rebuild or run `aml.blocklist-rebuild`. Limit counters rebuild from the database on a
  miss, so flushing Redis is safe.
- **Block and unblock.** A block holds the full available balance per currency and suspends payouts
  and settlement release. It never reverses a completed transaction. Unblock releases only the holds
  that block placed. `GET /admin/v1/aml/blocks` lists blocks.
- **STR export.** `POST /admin/v1/aml/cases/{ref}/str` builds the package (append-only); record the
  filing reference afterwards. Regenerating makes a new package, never an edit.
- **Disputes.** Opening a dispute holds the disputed amount, or what is available with a recorded
  `shortfall_minor`. Losing with too little posted balance returns `409 INSUFFICIENT_BALANCE` unless
  the resolver passes `acceptDeficit`, which leaves a negative merchant balance for Finance to recover.
- **Alerts.** Watch `core_aml_alerts_open` and `core_aml_alert_sla_breaches_total`, and
  `core_aml_precheck_duration_seconds` (target well inside 20 ms).
