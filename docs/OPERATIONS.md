# Operations

Runbooks for what can fail in production (spec 13, 16). Each runbook names the signal that starts
it, the checks to run, the actions to take, and what must not be done.

Metrics are at `GET /metrics` (bearer `METRICS_TOKEN`). Queues are under the Redis prefix
`QUEUE_PREFIX` (default `mulapay-core`). The operations surface is `/admin/v1/ops/*`; start at
`GET /admin/v1/ops/overview` (queues, consumer, stuck transactions, suspense, open incidents,
pending approvals, platform volume from the rollups).

## How these runbooks are tested

The fenced blocks tagged `runbook:<name>` in this file are executed by
`test/integration/runbooks.int-spec.ts` against a database with real scenarios:

- `sql runbook:<name>` blocks run in a read-only transaction. A block that does not parse, names a
  column that does not exist, or writes, fails the suite.
- `http runbook:<name>` blocks hold one `METHOD /path` line (and an optional JSON body below it).
  The test checks that the route exists in the committed OpenAPI documents. A `GET` without
  `{placeholders}` is also called as a super admin and must answer `200`.
- Each runbook has a scenario in that file that creates the failure (a stuck payment, a lagging
  cursor, a suspense balance, a failed delivery, and so on) and follows the steps.
- Blocks tagged `sql manual` and `http manual` change data. They are not run as a block: the
  scenario tests cover the same actions through the application.

An index of the runbooks:

| Runbook                                                           | Starts from                                         |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| [Stuck transaction](#stuck-transaction)                           | `core_transactions_stuck` above 0 for 15 minutes    |
| [Consumer lag](#consumer-lag)                                     | lag above 60 s, or a stale consumer heartbeat       |
| [Ledger mismatch](#ledger-mismatch)                               | `core_ledger_integrity_failures` above 0 (page)     |
| [Suspense balance](#suspense-balance)                             | suspense non-zero for over an hour                  |
| [Webhook backlog](#webhook-backlog)                               | webhook queue depth or failure rate                 |
| [Outbox rows that exhausted their attempts](#outbox-exhausted)    | `core_outbox_exhausted_total`                       |
| [Failed settlement](#failed-settlement)                           | a batch in `failed`, or `releasing` for too long    |
| [Compromised API key](#compromised-api-key)                       | a merchant reports a leaked key                     |
| [Queue depth](#queue-depth)                                       | `core_queue_depth` growing, a queue-depth incident  |
| [Notification delivery failures](#notification-delivery-failures) | `core_notification_deliveries_backlog`, failed rows |
| [Report failures](#report-failures)                               | a report `failed`, or stuck `queued`/`running`      |
| [Complaint SLA breaches](#complaint-sla-breaches)                 | `core_complaint_sla_breaches_total`                 |
| [Rollup staleness](#rollup-staleness)                             | dashboard analytics or overview volume looks old    |
| [Maintenance mode](#maintenance-mode)                             | a planned change, or an emergency stop of writes    |
| [Approvals](#approvals)                                           | `core_approvals_pending`                            |
| [Provider disable and routing](#provider-disable-and-routing)     | a provider is down or must be taken out             |
| [API request log buffer](#api-request-log-buffer)                 | `llen apilog:buffer` grows                          |
| [Rate limits and signatures](#rate-limits-and-signatures)         | merchants report `429` or signature errors          |
| [Sandbox](#sandbox)                                               | test payments stay `created`                        |
| [Compliance](#compliance-phase-7)                                 | AML, KYC and dispute operations                     |

## Stuck transaction

<!-- runbook:stuck-transaction -->

**Symptoms.** `core_transactions_stuck` above 0 for `OPS_STUCK_TXN_MINUTES` (15). A sev3 incident
`ops:stuck_transactions` opens, and becomes sev2 once the oldest has waited
`OPS_STUCK_TXN_SEV2_MINUTES` (60). A `stale_processing_transaction` reconciliation exception.

A transaction is stuck when it is `processing` and its attempt started more than the threshold ago.
The Core API never decides an unknown outcome. A payment with `outcome_unknown = true` stays
`processing` until the Provider Gateway reports a result or a status check returns one.

1. List them, oldest first.

```http runbook:stuck-transaction
GET /admin/v1/ops/stuck-transactions?olderThanMinutes=15
```

```sql runbook:stuck-transaction
select t.ref, t.type, t.provider, t.outcome_unknown, t.gateway_external_id,
       t.amount_minor, t.currency, now() - coalesce(t.initiated_at, t.created_at) as stuck_for
  from core.transactions t
 where t.status = 'processing'
   and t.created_at > now() - interval '7 days'
   and coalesce(t.initiated_at, t.created_at) < now() - interval '15 minutes'
 order by coalesce(t.initiated_at, t.created_at), t.ref
 limit 50;
```

2. Is it one provider or all of them? Group by `provider`. One provider: go to
   [Provider disable and routing](#provider-disable-and-routing). All of them: check
   [Consumer lag](#consumer-lag) first, because outcomes arrive through the consumer.
3. Does the gateway know the transaction? The gateway gap run (every `RECON_GAP_INTERVAL_SECONDS`)
   looks each stale transaction up by `gateway_external_id` and records the answer on the exception.
   Read the open ones, newest first.

```sql runbook:stuck-transaction
select x.ref, x.kind, x.severity, x.status, x.created_at
  from core.reconciliation_exceptions x
 where x.kind in ('stale_processing_transaction', 'gateway_state_differs')
   and x.status in ('open', 'investigating')
 order by x.created_at desc
 limit 50;
```

```http runbook:stuck-transaction
GET /admin/v1/reconciliation/exceptions?status=open&kind=stale_processing_transaction
```

4. Take the exception: assign it (`.../exceptions/{ref}/assign`), add notes, and resolve it
   `matched_manually` only after the gateway's own record and ours agree. **Never** edit
   `core.transactions` by hand and never post a ledger entry to "finish" a payment: the outcome comes
   from the gateway event (or an explicit status check), and the ledger entry follows the state
   machine.
5. If the gateway has no record of an operation core sent, that is
   `core_transaction_missing_at_gateway`, a critical exception. Escalate to the gateway team before
   anything else.
6. When the count returns to 0 the incident moves to `monitoring` by itself. A person resolves it
   (`POST /admin/v1/incidents/{ref}/resolve`), because a machine never closes an incident.

```http runbook:stuck-transaction
POST /admin/v1/incidents/{ref}/resolve
{"body": "Gateway outage ended; every transaction settled by the consumer."}
```

## Consumer lag

<!-- runbook:consumer-lag -->

**Symptoms.** Lag above `CONSUMER_LAG_ALERT_SECONDS` (60) or a heartbeat older than that. Payments
stay `processing` after the provider finished. The consumer runs in the worker process
(`APP_ROLE=worker`) and reads the gateway's `operation_events` table through the read-only pool.

1. Read the cursor: position, holder, heartbeat, lag in seconds, events behind.

```http runbook:consumer-lag
GET /admin/v1/ops/consumer-cursors
```

```sql runbook:consumer-lag
select c.name, c.position, c.holder, c.heartbeat_at,
       now() - c.heartbeat_at as heartbeat_age,
       (select max(e.id) from public.operation_events e) - c.position as events_behind
  from core.consumer_cursors c
 order by c.name;
```

2. Heartbeat stale and `holder` set: the worker is down or hung. Restart the worker. The consumer
   takes the cursor over after its lease lapses and applies events idempotently (a repeated event
   is a no-op), so a restart never double-applies.
3. Heartbeat fresh but events behind keeps growing: the consumer is running but slow. Look at
   `core_db_pool_connections`, `core_transaction_event_rejections_total` (a rejected event is
   skipped with a log line, not retried forever), and the queue `gateway-chase`.
4. Replica lag: the consumer reads through `DATABASE_RO_URL`. Replica lag above 30 s delays it.
5. **Rewinding the cursor** (re-reading events after a bad deploy) needs a reason and a second
   person. Rewinding never un-applies an event; replayed events are no-ops for transactions already
   in the target state.

```http runbook:consumer-lag
POST /admin/v1/ops/consumer-cursors/{name}/rewind
{"position": "12000", "reason": "Re-read after a bad deploy"}
```

The answer is `202` with an approval. A different staff member with `ops:approve` approves it
(see [Approvals](#approvals)); only then does the cursor move. Moving it forward is refused
(`not_a_rewind`).

## Ledger mismatch

<!-- runbook:ledger-mismatch -->

**Symptoms.** `core_ledger_integrity_failures{kind}` above 0, a sev1 incident
`ledger_integrity:{environment}:...`, and reconciliation exceptions of kind `ledger_*`. This pages.
The database prevents each of these; a finding means a constraint was bypassed or a bug reached the
database.

1. **Stop making it worse.** If new postings may be wrong, turn on [maintenance mode](#maintenance-mode)
   (writes refused, reads allowed) while you investigate.
2. Read what the run found.

```http runbook:ledger-mismatch
GET /admin/v1/reconciliation/exceptions?status=open&severity=critical
```

```http runbook:ledger-mismatch
GET /admin/v1/incidents?open=true&severity=sev1
```

3. Re-check each failure kind yourself. All three queries must return no rows on a healthy ledger.

```sql runbook:ledger-mismatch
-- entries that do not balance, have fewer than two lines, or mix currencies
select e.ref, e.created_at,
       count(l.entry_id) as line_count,
       coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0) as debits,
       coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0) as credits
  from core.journal_entries e
  left join core.journal_lines l on l.entry_id = e.id and l.created_at = e.created_at
 where e.created_at > now() - interval '7 days'
 group by e.id, e.created_at, e.ref
having count(l.entry_id) < 2
    or coalesce(sum(l.amount_minor) filter (where l.direction = 'debit'), 0)
       <> coalesce(sum(l.amount_minor) filter (where l.direction = 'credit'), 0)
    or coalesce(bool_or(l.currency <> e.currency), false)
 order by e.created_at, e.ref
 limit 100;
```

```sql runbook:ledger-mismatch
-- account balances that disagree with the journal
with journal as (
  select account_id, currency,
         coalesce(sum(amount_minor) filter (where direction = 'debit'), 0) as debits,
         coalesce(sum(amount_minor) filter (where direction = 'credit'), 0) as credits
    from core.journal_lines
   group by account_id, currency
)
select a.code, a.environment, coalesce(b.currency, j.currency) as currency,
       coalesce(b.posted_debits_minor, 0) as recorded_debits, coalesce(j.debits, 0) as journal_debits,
       coalesce(b.posted_credits_minor, 0) as recorded_credits, coalesce(j.credits, 0) as journal_credits
  from core.account_balances b
  full join journal j on j.account_id = b.account_id and j.currency = b.currency
  join core.accounts a on a.id = coalesce(b.account_id, j.account_id)
 where coalesce(b.posted_debits_minor, 0) <> coalesce(j.debits, 0)
    or coalesce(b.posted_credits_minor, 0) <> coalesce(j.credits, 0)
 order by a.code
 limit 100;
```

```sql runbook:ledger-mismatch
-- total debits against total credits, per environment and currency
select a.environment, b.currency,
       sum(b.posted_debits_minor) as debits, sum(b.posted_credits_minor) as credits
  from core.account_balances b
  join core.accounts a on a.id = b.account_id
 group by a.environment, b.currency
having sum(b.posted_debits_minor) <> sum(b.posted_credits_minor);
```

4. **Never** `update` or `delete` a posted entry or an `account_balances` row, and never
   disable the guard triggers. Correct with a reversing entry
   (`ReversalService.reverseEntry`, through the `corrected_with_reversal` resolution), or a
   documented write-off. Both need a second person (see the write-off procedure in
   `RECONCILIATION.md`).
5. Run the check again after the correction.

```http runbook:ledger-mismatch
POST /admin/v1/reconciliation/runs
{"kind": "ledger_integrity", "environment": "live", "idempotencyKey": "ledger-recheck-2025-01-01-a"}
```

6. The incident stays open until a person resolves it with the cause in the update and a
   postmortem (`POST /admin/v1/incidents/{ref}/postmortem`).

## Suspense balance

<!-- runbook:suspense-balance -->

**Symptoms.** `core_suspense_balance_minor` non-zero. Suspense (`9000:suspense`) holds money that
was received or sent without a known owner. It must be cleared. An incident `ops:suspense_drift:...`
opens as sev2 after `SUSPENSE_ALERT_HOURS` (1) and becomes sev1 after `OPS_SUSPENSE_SEV1_HOURS`
(24). The hourly ledger integrity run also reports any non-zero suspense as a sev1 incident; while
that incident is open the drift incident is not opened a second time.

1. Read the balance and how long it has been non-zero.

```http runbook:suspense-balance
GET /admin/v1/ops/suspense
```

```sql runbook:suspense-balance
select a.code, a.environment, b.currency,
       b.posted_debits_minor - b.posted_credits_minor as balance_debit_positive
  from core.account_balances b
  join core.accounts a on a.id = b.account_id
 where a.purpose = 'suspense' and b.posted_debits_minor <> b.posted_credits_minor
 order by a.environment, b.currency;
```

2. Find what posted to suspense, newest first. The entry's `source` and `source_id` name the
   originating operation (every posting has one).

```sql runbook:suspense-balance
select e.ref, e.created_at, e.source, e.source_id, l.direction, l.amount_minor, l.currency
  from core.journal_lines l
  join core.accounts a on a.id = l.account_id and a.purpose = 'suspense'
  join core.journal_entries e on e.id = l.entry_id and e.created_at = l.created_at
 where l.created_at > now() - interval '30 days'
 order by e.created_at desc
 limit 50;
```

3. Identify the owner of the money (a provider statement row, a gateway operation, a merchant).
   Open or take the matching reconciliation exception and resolve it:
   `corrected_with_reversal` when an entry was wrong, `written_off` (two people) when the amount
   is a real loss, `matched_manually` only when the books already agree.
4. **Never** post a free-form entry to zero the account. Posting goes through
   `PostingService.postEntry` with a reference to the originating operation, or through a
   reconciliation resolution.

## Webhook backlog

<!-- runbook:webhook-backlog -->

**Symptoms.** `core_queue_depth{queue="webhook-delivery"}` or its oldest-job age grows; merchants
report late webhooks; `core_webhook_delivery_duration_seconds` shows a slow tail; webhook failure
rate above 20%.

1. Is the **worker** running? Webhook delivery, the outbox and the sandbox all run only in the
   worker (`APP_ROLE=worker`). No worker, no deliveries, and the API keeps accepting requests.
2. Is the **outbox** draining? The count should be near zero and the oldest row young. Rows with
   `attempts >= 10` are stuck (`last_error` says why; `core_outbox_exhausted_total`). A row is
   only claimed by a dispatcher that has a handler for its `event_type`, so an old worker after a
   deploy leaves new event types untouched.

```sql runbook:webhook-backlog
select count(*) as waiting, min(created_at) as oldest
  from core.outbox
 where published_at is null and attempts < 10;
```

3. Are deliveries pending? Pending deliveries whose `next_attempt_at` passed more than a minute ago
   are re-queued by the recovery sweep on every outbox tick; if they stay, the `webhook-delivery`
   workers are down or saturated (concurrency 32).

```sql runbook:webhook-backlog
select status, count(*) as deliveries
  from core.webhook_deliveries
 where created_at > now() - interval '2 days'
 group by status
 order by status;
```

```http runbook:webhook-backlog
GET /admin/v1/ops/queues
```

4. One merchant's endpoint failing is not a platform problem: it retries on its schedule (30 s,
   2 m, 10 m, 1 h, 6 h, 24 h) and is auto-disabled after 50 consecutive failures. The merchant is
   told through a `webhook_endpoint.auto_disabled` event, an in-app and email notification, and the
   audit trail. Re-enabling is `PATCH /v1/webhook-endpoints/{ref}` with `{"status":"active"}`, or
   the dashboard.
5. Redis down: deliveries stop being queued, but nothing is lost. Rows stay in Postgres (outbox,
   deliveries); the recovery sweep re-queues them when Redis returns.
6. A queue that is stuck on failed jobs: [Queue depth](#queue-depth).

**Replaying** after an incident: `POST /dashboard/v1/webhook-deliveries/replay` with the event
type and date range, at most 500 per call; repeat until `truncated` is false. Receivers deduplicate
on `MulaPay-Event-Id`.

```http runbook:webhook-backlog
POST /dashboard/v1/webhook-deliveries/replay
{"eventType": "payment.succeeded", "from": "2025-01-01T00:00:00Z", "to": "2025-01-01T06:00:00Z"}
```

## Outbox rows that exhausted their attempts {#outbox-exhausted}

<!-- runbook:outbox-exhausted -->

```sql runbook:outbox-exhausted
select id, event_type, aggregate_id, attempts, last_error
  from core.outbox
 where published_at is null and attempts >= 10
 order by created_at
 limit 100;
```

Fix the cause (missing handler version, a poison row, a database fault), then reset the row. Handlers
are idempotent, so running one again is safe. The announcements of money movements must not be
deleted: a missing `merchant_event.created` row means a merchant never gets that webhook.

```sql manual
update core.outbox set attempts = 0, available_at = now(), locked_at = null where id = '<id>';
```

## Failed settlement

<!-- runbook:failed-settlement -->

**Symptoms.** A batch is `failed`, or `releasing` for longer than expected (the payout is waiting
for the gateway), or a settlement payout shows in the stuck transactions.

A batch moves `draft → pending_approval → approved → releasing → paid`. Release creates the payout
and a hold on the merchant's payable first; the gateway call happens afterwards in a queued job
under the same external id. What a gateway answer does:

| Gateway answer                                | Result                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| accepted                                      | payout `processing`; the outcome arrives by event or status check                                       |
| 400 or 409 (refused before creating anything) | payout `failed`, hold released, batch `failed` (a Core bug: logged error)                               |
| 401, 403, 404, 429                            | nothing decided; the job is retried under the same key                                                  |
| 504, timeout, 5xx, unreadable                 | payout `processing` with `outcome_unknown`; hold stays; never retried under a new key and never assumed |

1. Find the batches.

```http runbook:failed-settlement
GET /admin/v1/settlement/batches?status=failed
```

```sql runbook:failed-settlement
select b.ref, b.status, b.environment, b.net_minor, b.currency, b.payout_ref,
       b.failure_code, b.released_at, b.updated_at
  from core.settlement_batches b
 where b.status = 'failed'
    or (b.status = 'releasing' and b.released_at < now() - interval '30 minutes')
 order by b.updated_at desc
 limit 50;
```

2. A `failed` batch has already released its hold and returned the merchant's payable: no money
   is lost or duplicated. Read `failure_code` and the batch events, fix the cause (the destination,
   the provider, the amount), then run the cycle again (`POST /admin/v1/settlement/batches`); the period it
   covered is settled by the new batch, and a failed batch is never reused.

```http runbook:failed-settlement
GET /admin/v1/settlement/batches/{ref}
```

3. A batch that stays `releasing`: its payout is `processing`. Treat it as a
   [stuck transaction](#stuck-transaction). The hold is only captured by a confirmed success and
   only released by a confirmed failure. **Never** cancel a `releasing` batch or repeat the release to
   "try again": a second payout is how money is paid twice.
4. Provider is down: [disable the provider](#provider-disable-and-routing) so the next batch
   is routed elsewhere.
5. A success that arrives after the batch was marked `failed` (the gateway said failed, then paid) changes nothing
   in the ledger and raises a reconciliation exception: money may have left at the provider while the ledger says
   it did not. Treat that exception as critical and resolve it with the provider statement.
6. A paid batch tells the merchant by a `settlement.paid` event and a notification; check
   [Notification delivery failures](#notification-delivery-failures) if they were not received.

## Compromised API key

<!-- runbook:api-key-compromise -->

1. Revoke it: dashboard `DELETE /dashboard/v1/api-keys/{id}`. It stops working on every server at
   once; the cache entry is evicted through a Redis marker. If Redis was unreachable at that moment
   the key is revoked in Postgres and cached copies lapse within 60 seconds: check the
   `api key cache eviction failed` log line.

```http runbook:api-key-compromise
DELETE /dashboard/v1/api-keys/{id}
```

2. Roll instead if the integration must continue: `POST /dashboard/v1/api-keys/{id}/roll` with
   `gracePeriodHours: 0`.

```http runbook:api-key-compromise
POST /dashboard/v1/api-keys/{id}/roll
{"gracePeriodHours": 0}
```

3. Read the key's activity: `GET /dashboard/v1/request-logs` (filter by time; each entry names
   the key and the client address) and the audit trail. A live key with `payouts:write` also
   needed the signing secret: if that leaked too, rolling replaces both.

```http runbook:api-key-compromise
GET /dashboard/v1/request-logs
```

4. If the merchant itself is compromised, suspend it (`POST /admin/v1/merchants/{ref}/suspend`):
   this evicts all of its keys from the cache and live payments are refused with
   `MERCHANT_NOT_ACTIVE`.

```http runbook:api-key-compromise
POST /admin/v1/merchants/{ref}/suspend
{"reason": "Credentials leaked"}
```

5. Rotate webhook secrets if the endpoint secret leaked:
   `POST /v1/webhook-endpoints/{ref}/rotate-secret` with `graceHours: 0`.

```http runbook:api-key-compromise
POST /v1/webhook-endpoints/{ref}/rotate-secret
{"graceHours": 0}
```

**Never** change `api_keys`, `merchants.status` or `webhook_endpoints` by hand in production
without evicting the cache (`ApiKeyCache.evict`/`evictMerchant`): a cached key keeps its old
state for up to 60 seconds.

## Queue depth

<!-- runbook:queue-depth -->

**Symptoms.** A sev3 incident `ops:queue_depth:{queue}` (sev2 at five times the threshold) opens when a
queue stays above `OPS_QUEUE_DEPTH_THRESHOLD` (1000) for `OPS_QUEUE_DEPTH_SUSTAIN_SECONDS` (300).
`core_queue_depth` and `core_queue_oldest_job_seconds` show it per queue.

1. Read every queue: waiting, active, delayed, failed, paused, oldest wait.

```http runbook:queue-depth
GET /admin/v1/ops/queues
```

2. Waiting grows, active is 0: no worker is consuming the queue. Check the worker process and that
   the queue is not paused (the table says).
3. Waiting grows, active at the concurrency limit: the work is slower than the arrivals. Look
   for a slow dependency (database, a vendor) before adding workers.
4. A queue with many failed jobs: read the cause in the logs (`queue`, `job`, `error` name; payloads
   are identifiers only). Fix the cause, then retry the failed jobs in batches. Every processor is
   idempotent, so a retry is safe.

```http runbook:queue-depth
POST /admin/v1/ops/queues/{name}/retry-failed
{"limit": 100}
```

5. To protect a dependency, pause the queue (running jobs finish, none start) and resume when it
   is back. A paused queue keeps its jobs.

```http runbook:queue-depth
POST /admin/v1/ops/queues/{name}/pause
```

```http runbook:queue-depth
POST /admin/v1/ops/queues/{name}/resume
```

6. Retries, pause and resume are audited (`queue.failed_retried`, `queue.paused`, `queue.resumed`). The incident moves to `monitoring` when the
   depth is back under the threshold; resolve it by hand.

## Notification delivery failures

<!-- runbook:notification-delivery -->

**Symptoms.** `core_notification_deliveries_backlog` (pending and failed over the last day) grows,
`core_notification_deliveries_total{outcome="failed"}` rises, or a person did not get a mandatory
notice. Each delivery is per channel with its own retries: `NOTIFICATION_MAX_ATTEMPTS` (6) attempts,
exponential backoff from `NOTIFICATION_RETRY_BASE_SECONDS` (30), then `failed`. A refusal that retrying
cannot change (an invalid address, a rejected message) fails at once with a short `error` code.
In-app notifications are rows and do not fail.

1. Read the delivery log.

```http runbook:notification-delivery
GET /admin/v1/notifications/deliveries?status=failed
```

```sql runbook:notification-delivery
select d.channel, d.status, d.error, count(*) as deliveries,
       min(d.created_at) as oldest, max(d.attempts) as max_attempts
  from core.notification_deliveries d
 where d.created_at > now() - interval '1 day' and d.status in ('pending', 'failed')
 group by d.channel, d.status, d.error
 order by deliveries desc;
```

2. Read the `error` code:

| `error`                                                                                         | Meaning and action                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel_not_configured`                                                                        | No vendor is configured for the channel (`EMAIL_PROVIDER`, `SMS_PROVIDER`, `FCM_*`; SES and Twilio are not implemented and also answer this). Retried, then `failed`. Fix the variables and restart; failed rows are not re-sent |
| `provider_auth_failed`                                                                          | The vendor refused our credentials (`*_API_KEY`, FCM service account). Retried, then `failed`. Rotate the credential                                                                                                             |
| `provider_timeout`, `provider_network`, `timeout`, `provider_status_5xx`, `provider_unreadable` | The vendor is down or slow. Retried with backoff; act only if rows exhaust                                                                                                                                                       |
| `provider_rejected_<status>`                                                                    | The vendor refused this message (a bad address or content). Not retried. Fix the destination (`PUT /dashboard/v1/notification-destinations`)                                                                                     |
| `no_destination`                                                                                | The person has no SMS or push destination registered. Not retried                                                                                                                                                                |
| `no_template`, `unknown_template`, `render_failed`, `subject_required`                          | A template is missing or broken for the channel and locale. Fix it (`notification_templates:manage`)                                                                                                                             |

3. Pending rows whose `next_attempt_at` passed are re-queued by the sweep (every minute). If they
   stay pending, the `notification-send` queue has no worker: [Queue depth](#queue-depth).
4. A duplicate notice is possible if a worker dies after the vendor accepted but before the row was
   marked sent: the sweep sends again after the lease. This is accepted (a notice twice, never none).
5. Failed deliveries are kept for audit and never re-sent automatically. For a notice that must
   reach people (an incident, a security alert), broadcast again.

```http runbook:notification-delivery
POST /admin/v1/notifications/broadcast
{"audience": "staff", "headline": "Incident update", "message": "See the status page."}
```

## Report failures

<!-- runbook:report-failures -->

**Symptoms.** A requester says a report is stuck, `core_reports_total{outcome="failed"}` rises, a
schedule turned itself off.

A report is `queued → running → ready` (or `failed`, later `expired`). A worker claims it with a
lease; a worker that dies leaves `running` with an expired lease, and the next tick takes it over.
Generation retries 3 times (30 s exponential backoff), then the report is `failed` with a short
`error` code, no file, and the requester is notified.

1. List the problem reports.

```http runbook:report-failures
GET /admin/v1/reports?status=failed
```

```sql runbook:report-failures
select r.ref, r.type, r.format, r.status, r.attempts, r.error, r.created_at, r.lease_expires_at
  from core.reports r
 where (r.status = 'failed' and r.created_at > now() - interval '7 days')
    or (r.status in ('queued', 'running') and r.created_at < now() - interval '15 minutes')
 order by r.created_at desc
 limit 50;
```

2. Read `error`: `report_too_large` (more than `REPORT_MAX_ROWS` rows; final at once, ask again with a narrower
   window) or `generation_failed` (any other cause, retried first; the log line `report generation failed` names
   the error: usually object storage or the database).
3. `queued` for long with no worker on `report-generate`: [Queue depth](#queue-depth). `running` with an
   expired lease: the next tick takes it over; if it does not, the worker is down.
4. A failed report is not retried by itself after the last attempt. Ask for a new one; the old one stays
   as history. A schedule counts consecutive failures and turns itself off at
   `REPORT_SCHEDULE_MAX_FAILURES` (5), telling its recipients.
5. Files are deleted 7 days after generation (the row becomes `expired`); download links are valid for
   15 minutes and each link is audited.

## Complaint SLA breaches

<!-- runbook:complaint-sla -->

**Symptoms.** `core_complaint_sla_breaches_total` rises, `core_complaints_open` grows, a breach
notification reached the supervisors. A breach is recorded once, at the moment the deadline
(`sla_due_at`, calendar time from the category's `sla_hours`) passes. Breached complaints stay in the queue
until resolved.

1. The queue, longest overdue first.

```http runbook:complaint-sla
GET /admin/v1/complaints/sla-breaches
```

```sql runbook:complaint-sla
select c.ref, c.status, c.priority, c.sla_due_at, c.breached_at,
       now() - c.sla_due_at as overdue_by
  from core.complaints c
 where c.breached and c.status in ('open', 'in_progress', 'awaiting_customer', 'escalated')
 order by c.sla_due_at
 limit 100;
```

2. Unassigned complaints first: assign them (`POST /admin/v1/complaints/{ref}/assign`). Then escalate
   what cannot be answered (`.../escalate`) and answer or resolve the rest.

```http runbook:complaint-sla
GET /admin/v1/complaints?unassigned=true&breached=true
```

3. If breaches are systematic (many at the same moment), the sweep (`support-ops`, every minute) may have
   stopped: [Queue depth](#queue-depth) for `support-ops`.

## Rollup staleness

<!-- runbook:rollup-staleness -->

**Symptoms.** Dashboard analytics and the platform volume on the operations overview are old or
too low. They read only the daily rollups (`core.daily_merchant_rollups`), never the transactions. The
`rollup-aggregate` queue recomputes today every 15 minutes (and yesterday during the first hour of the day)
and the previous days each night at 01:30 UTC. A day is recomputed whole, so a late run corrects itself.

1. When was the latest day computed?

```sql runbook:rollup-staleness
select r.environment, max(r.date) as latest_day, max(r.computed_at) as last_computed,
       now() - max(r.computed_at) as age
  from core.daily_merchant_rollups r
 group by r.environment
 order by r.environment;
```

2. Age under 15 minutes while payments flow: healthy. Older: the `rollup-aggregate` queue has no worker or
   its jobs fail (`core_rollup_runs_total{outcome="failed"}`): [Queue depth](#queue-depth).
3. After a fix, the next 15-minute tick repairs today and the nightly job the previous days. Rollups are
   derived data and can be recomputed at any time; they never feed money movements.

## Maintenance mode

<!-- runbook:maintenance-mode -->

Turns every write on every surface into `503 MAINTENANCE_MODE` with `Retry-After`. Reads continue. The
exceptions are the switch itself and sign-in, token refresh, MFA and step-up. The change is audited
(`maintenance.enabled`, `maintenance.disabled`), needs `ops:manage` and a recent step-up, and takes effect on
every process within 2 seconds.

```http runbook:maintenance-mode
GET /admin/v1/ops/maintenance-mode
```

```http runbook:maintenance-mode
POST /admin/v1/ops/maintenance-mode
{"enabled": true, "message": "Upgrading the ledger", "retryAfterSeconds": 120}
```

1. Turn it on before a migration or while investigating a [ledger mismatch](#ledger-mismatch). Provider
   events and queued jobs keep running; only new API writes stop. Tell merchants through the incident
   and the public status feed (`GET /v1/status`).
2. Turn it off with `{"enabled": false}`.
3. If the database cannot be read, the guard lets requests through (fails open) and logs
   `MAINTENANCE_MODE` unreadable; the database being down already fails the writes.
4. Merchants who retry after `Retry-After` need no idempotency change: a refused write created nothing.

## Approvals

<!-- runbook:approvals -->

High-risk operations need a second person: rewinding the consumer cursor, disabling a provider that
carries traffic, deleting a routing rule, and (in production) changing a feature flag. The request
answers `202` with an approval; nothing changes until a different staff member with `ops:approve` and a
recent step-up approves. The requester can never approve their own request (a database trigger too).
A pending request expires after `APPROVAL_TTL_HOURS` (24); expiry changes nothing.

```http runbook:approvals
GET /admin/v1/ops/approvals?status=pending
```

```sql runbook:approvals
select a.ref, a.kind, a.resource_type, a.resource_id, a.status, a.requested_at, a.expires_at
  from core.approvals a
 where a.status = 'pending'
 order by a.requested_at
 limit 50;
```

1. Read the request and its reason: `GET /admin/v1/ops/approvals/{ref}`.
2. Approve (the change is applied at once, in the same transaction as the decision) or reject (nothing changes):

```http runbook:approvals
POST /admin/v1/ops/approvals/{ref}/approve
{"note": "Checked against the gateway status."}
```

```http runbook:approvals
POST /admin/v1/ops/approvals/{ref}/reject
{"note": "Not needed; the provider recovered."}
```

3. A request that expired is not revived: ask again. Every request and decision is audited.

## Provider disable and routing

<!-- runbook:provider-routing -->

**Symptoms.** A provider is failing (`core_transactions_stuck` for one provider, gateway 5xx), or must be
taken out for maintenance.

1. See the providers: the switch, health and the currencies each carries.

```http runbook:provider-routing
GET /admin/v1/providers
```

```http runbook:provider-routing
GET /admin/v1/routing-rules
```

```sql runbook:provider-routing
select r.currency, r.priority, r.provider, r.weight, r.enabled
  from core.routing_rules r
 order by r.currency, r.priority, r.provider;
```

2. Mark it `degraded` or `down` to steer traffic, or disable it. If every currency routed to it has another
   enabled provider with an enabled rule, the change applies at once. Otherwise the request needs a reason
   and an approval (`202`): disabling the last route of a currency would stop all payments in it.

```http runbook:provider-routing
PATCH /admin/v1/providers/{id}
{"enabled": false, "reason": "MTN is returning 5xx for all collections"}
```

3. Deleting a routing rule is always an approval. Disabling the last enabled rule of a currency is too.
4. Payments already `processing` with the provider are not moved: they are resolved by the provider's
   outcome ([Stuck transaction](#stuck-transaction)).
5. To bring it back, `PATCH` `{"enabled": true, "health": "healthy"}`. Every change is audited with the
   reason.

## API request log buffer

<!-- runbook:request-log-buffer -->

Entries sit in the Redis list `apilog:buffer` until the worker flushes them (every 2 s, batches
of 500). If the list keeps growing (`llen apilog:buffer`), the worker or the database is down. At
200,000 entries new ones are dropped (`core_api_request_logs_dropped_total{reason="buffer_full"}`)
so logging can never take the API down. Batches a dead worker held are finished by the next flush
after 30 seconds; inserts are idempotent. Logs are kept 90 days: drop the partition, never
`DELETE` (the table is append-only).

```http runbook:request-log-buffer
GET /admin/v1/ops/overview
```

## Rate limits and signatures

<!-- runbook:rate-limits -->

- `core_rate_limit_rejections_total{scope}` shows which limit is refusing. `auth_failures` is
  the per-client failed-authentication limit: a spike usually means a merchant with a wrong key in a
  retry loop (their address gets `429` for a minute) or a scan.
- With Redis down, writes get `503` (the rate limit and replay protection cannot be checked) and
  reads continue.
- A merchant reporting `SIGNATURE_REPLAYED`: two identical requests were signed in the same
  second. They must sign each attempt again, at least a second later.
- `SIGNATURE_TIMESTAMP_INVALID`: their clock is more than 300 s from ours; check NTP.

```http runbook:rate-limits
GET /admin/v1/ops/overview
```

## Sandbox

<!-- runbook:sandbox -->

Test payments are resolved by the worker (queue `gateway-chase`, job `sandbox.step`). A test
payment stuck in `created` means the worker or the outbox is not running. `timeout` payments
stay `processing` for `SANDBOX_TIMEOUT_RESOLVE_SECONDS` on purpose.

```http runbook:sandbox
GET /admin/v1/ops/queues
```

## Incidents and the public status feed

<!-- runbook:incidents -->

Open an incident for any customer-visible problem (`POST /admin/v1/incidents`); automatic ones open
for ledger integrity, suspense drift, stuck transactions and queue depth, with the dedupe rule one open
incident per signal. A person owns every incident and resolves it. The public feed
(`GET /v1/status`, no authentication, cached 30 seconds) shows only the `public_message` headline, a coarse
impact (`minor` or `major`), a whitelist of component names and the updates marked public; resolved
public incidents stay for 14 days. Internal updates, the postmortem, the cause and every internal detail are never
public. Write the public text as if the merchant will read it.

```http runbook:incidents
GET /v1/status
```

```http runbook:incidents
POST /admin/v1/incidents/{ref}/updates
{"status": "monitoring", "body": "The provider has recovered; we are watching.", "public": true}
```

## Compliance (Phase 7)

<!-- runbook:compliance -->

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
  Assign an investigator (`POST /admin/v1/disputes/{ref}/assign`), keep notes, and watch the evidence
  deadline: staff are told `DISPUTE_DEADLINE_WARNING_HOURS` (48) before it and again when it passes.
- **Alerts.** Watch `core_aml_alerts_open` and `core_aml_alert_sla_breaches_total`, and
  `core_aml_precheck_duration_seconds` (target well inside 20 ms).

```http runbook:compliance
GET /admin/v1/disputes
```

```sql runbook:compliance
select d.ref, d.status, d.amount_minor, d.hold_minor, d.shortfall_minor
  from core.disputes d
 where d.status in ('open', 'under_review')
 order by d.created_at desc
 limit 50;
```
