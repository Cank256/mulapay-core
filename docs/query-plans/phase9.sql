-- Phase 9 (hardening) query-plan review (spec 9.2 rule 7, section 16). Re-plans the hot paths at a
-- larger volume than Phases 1 to 5 and adds the Phase 6 to 8 and data-lifecycle queries that had no
-- committed plan: balances, the stuck-transaction scans, rollups, settlement eligibility,
-- reconciliation, notifications, and the retention clean-ups.
--
-- Run as the database superuser (it switches `session_replication_role` to seed quickly; every
-- constraint that is not a trigger still applies):
--
--   psql "postgres://postgres:...@localhost:55432/mulapay" -f docs/query-plans/phase9.sql > docs/query-plans/phase9.txt
--
-- Seeds about 1M rows in one transaction, runs each query with EXPLAIN (ANALYZE, BUFFERS), then
-- rolls everything back. Part B is a before-and-after benchmark of one candidate index.
\set ON_ERROR_STOP on
\pset pager off
SET search_path = core;
BEGIN;
SET LOCAL statement_timeout = 0;
SET LOCAL session_replication_role = replica;
SELECT create_monthly_partitions('transactions', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '3 months')::date, 3, false);
SELECT create_monthly_partitions('notification_deliveries', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '3 months')::date, 3, false);
-- A UUID whose first 48 bits are `ts` in milliseconds, as the application's uuidv7() makes them
-- (only the ordering matters to the plans; the version nibble is not set).
CREATE FUNCTION pg_temp.uuid7_at(ts timestamptz) RETURNS uuid LANGUAGE sql AS
$$ SELECT encode(overlay(uuid_send(gen_random_uuid()) PLACING substring(int8send((extract(epoch FROM ts) * 1000)::bigint) FROM 3 FOR 6) FROM 1 FOR 6), 'hex')::uuid $$;
-- 2k merchants, each with a payable and a reserve account and a balance row.
INSERT INTO merchants (id, ref, legal_name, country, default_currency, created_at)
SELECT gen_uuid_v7(), gen_public_id('mch'), 'Merchant ' || g, 'UG', 'UGX', now() - make_interval(mins => g::int)
FROM generate_series(1, 2000) g;
CREATE TEMP TABLE seed_merchants ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY ref) AS n, id, ref FROM merchants;
INSERT INTO accounts (id, ref, environment, code, name, type, normal_balance, currency, merchant_id, purpose, is_system)
SELECT gen_uuid_v7(), gen_public_id('acct'), 'live', p.number || ':' || p.purpose || ':' || m.ref, p.purpose,
       'liability', 'credit', 'UGX', m.id, p.purpose, false
FROM seed_merchants m CROSS JOIN (VALUES ('2000', 'merchant_payable'), ('2010', 'merchant_reserve')) p (number, purpose);
INSERT INTO account_balances (account_id, currency, posted_debits_minor, posted_credits_minor)
SELECT id, 'UGX', 1000 * (n % 50), 1000 * (n % 50) + 500000 FROM (SELECT a.id, row_number() OVER () AS n FROM accounts a WHERE a.merchant_id IS NOT NULL) x;
-- 600k transactions over 80 days: 90% payments, 5% payouts, 5% refunds; 99.95% final, 0.05% still
-- processing (300 rows, 60 of them older than ten minutes: the stuck ones). `big` has 30,000.
CREATE TEMP TABLE seed_tx ON COMMIT DROP AS
SELECT g, gen_uuid_v7() AS id, gen_public_id('txn') AS ref,
       CASE WHEN g <= 30000 THEN (SELECT id FROM seed_merchants WHERE n = 1) ELSE m.id END AS merchant_id,
       CASE WHEN g % 20 = 0 THEN 'payout' WHEN g % 20 = 1 THEN 'refund' ELSE 'payment' END AS type,
       date_trunc('milliseconds', now() - make_interval(secs => (g * 7919) % (80 * 86400))) AS created_at,
       CASE WHEN g % 2000 = 7 THEN 'processing' WHEN g % 10 = 3 THEN 'failed' ELSE 'succeeded' END AS status
FROM generate_series(1::bigint, 600000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
-- The 300 processing rows are the 60 oldest-by-construction plus recent ones.
UPDATE seed_tx SET created_at = now() - make_interval(mins => (11 + g % 120)::int) WHERE status = 'processing' AND g % 5 = 0;
UPDATE seed_tx SET created_at = now() - make_interval(secs => 5 + g % 400) WHERE status = 'processing' AND g % 5 <> 0;
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, provider, channel, gateway_external_id, initiated_at, completed_at, created_at)
SELECT id, ref, merchant_id, 'live', type, status, 1000 + g % 9000, 30, 970 + g % 9000, 'UGX', CASE WHEN g % 2 = 0 THEN 'mtn' ELSE 'airtel' END, 'mobile_money',
       CASE WHEN type <> 'payment' OR status = 'processing' THEN 'po_' || g END, created_at,
       CASE WHEN status <> 'processing' THEN created_at + interval '30 seconds' END, created_at
FROM seed_tx;
-- 40k active holds, 4k of them for the big merchant's payouts.
INSERT INTO holds (id, ref, merchant_id, environment, account_id, currency, amount_minor, state, reason, idempotency_key, created_by, expires_at, captured_at, capture_key)
SELECT gen_uuid_v7(), gen_public_id('hold'), m.id, 'live', a.id, 'UGX', 5000 + g, CASE WHEN g % 50 = 0 THEN 'active' ELSE 'captured' END,
       CASE WHEN g % 100 = 0 THEN 'dispute:x' ELSE 'payout' END, 'seedhold-' || g, 'system:seed', now() + interval '1 hour',
       CASE WHEN g % 50 <> 0 THEN now() END, CASE WHEN g % 50 <> 0 THEN 'cap-' || g END
FROM generate_series(1::bigint, 120000) g JOIN seed_merchants m ON m.n = 1 + g % 2000
JOIN accounts a ON a.merchant_id = m.id AND a.purpose = 'merchant_payable';
-- 360k daily rollups: 2k merchants x 90 days x 2 providers.
INSERT INTO daily_merchant_rollups (merchant_id, environment, date, currency, channel, provider, payment_count, payment_minor, success_count, failure_count, computed_at)
SELECT m.id, 'live', (now()::date - d), 'UGX', 'mobile_money', p, 10 + d % 7, 100000 + d * 100, 9, 1, now()
FROM seed_merchants m CROSS JOIN generate_series(0, 89) d CROSS JOIN (VALUES ('mtn'), ('airtel')) p (p);
-- 200k notifications for 20k recipients, a delivery each over three monthly partitions.
CREATE TEMP TABLE seed_notes ON COMMIT DROP AS
SELECT g, gen_uuid_v7() AS id, gen_public_id('ntf') AS ref, md5((g % 20000)::text)::uuid AS recipient_id,
       date_trunc('milliseconds', now() - make_interval(secs => (g * 6007) % (80 * 86400))) AS created_at
FROM generate_series(1::bigint, 200000) g;
INSERT INTO notifications (id, ref, recipient_id, channel, template_code, resource_key, body, read_at, created_at)
SELECT id, ref, recipient_id, CASE WHEN g % 4 = 0 THEN 'email' ELSE 'in_app' END, 'payment.succeeded', 'res-' || g, 'body',
       CASE WHEN g % 4 <> 0 AND g % 10 < 8 THEN created_at END, created_at
FROM seed_notes;
INSERT INTO notification_deliveries (id, ref, notification_id, recipient_id, template_code, channel, status, next_attempt_at, created_at)
SELECT gen_uuid_v7(), gen_public_id('ndl'), id, recipient_id, 'payment.succeeded', 'email',
       CASE WHEN g % 100 = 0 THEN 'pending' ELSE 'sent' END, CASE WHEN g % 100 = 0 THEN created_at END, created_at
FROM seed_notes;
-- 50k reconciliation exceptions (2.5k open) and 5k runs.
INSERT INTO reconciliation_exceptions (id, ref, kind, severity, dedupe_key, status, resolution, resolved_at, resolved_by, first_seen_at, last_seen_at, created_at)
SELECT gen_uuid_v7(), gen_public_id('rce'), CASE WHEN g % 3 = 0 THEN 'stale_processing' ELSE 'amount_mismatch' END,
       CASE WHEN g % 7 = 0 THEN 'high' ELSE 'medium' END, 'dk-' || g, CASE WHEN g % 20 = 0 THEN 'open' ELSE 'resolved' END,
       CASE WHEN g % 20 <> 0 THEN 'matched_manually' END, CASE WHEN g % 20 <> 0 THEN now() END,
       CASE WHEN g % 20 <> 0 THEN gen_uuid_v7() END,
       now() - make_interval(mins => g::int), now() - make_interval(mins => g::int), now() - make_interval(mins => g::int)
FROM generate_series(1::bigint, 50000) g;
INSERT INTO reconciliation_runs (id, ref, kind, scope_key, run_key, triggered_by, started_at, finished_at, lease_expires_at, status)
SELECT gen_uuid_v7(), gen_public_id('rcr'), CASE WHEN g % 4 = 0 THEN 'gateway_gap' ELSE 'ledger_integrity' END, 'all', 'rk-' || g, 'job:seed',
       now() - make_interval(mins => g::int), now() - make_interval(mins => g::int) + interval '1 minute', now() - make_interval(mins => g::int) + interval '5 minutes', 'completed'
FROM generate_series(1::bigint, 5000) g;
-- 300k idempotency keys (2% expired more than a week ago) and 300k outbox rows (99% published,
-- 30% of them more than two weeks ago).
INSERT INTO idempotency_keys (id, merchant_id, environment, scope, key, request_fingerprint, status, response_status, response_body, locked_at, expires_at)
SELECT pg_temp.uuid7_at(now() - make_interval(secs => (g % 1000000)::int)), m.id, 'live', 'payments.create', 'idem-' || g, repeat('b', 64), 'completed', 201, '{}'::jsonb, now(),
       CASE WHEN g % 50 = 0 THEN now() - interval '8 days' ELSE now() + interval '1 day' - make_interval(secs => g % 80000) END
FROM generate_series(1::bigint, 300000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at, locked_at, published_at, created_at)
SELECT pg_temp.uuid7_at(now() - make_interval(days => d, secs => (g % 80000)::int)), 'merchant_event', g::text, 'merchant_event.created', '{}', 'seed:' || g,
       now() - make_interval(days => d), CASE WHEN g % 100 < 99 THEN now() - make_interval(days => d) END,
       CASE WHEN g % 100 < 99 THEN now() - make_interval(days => d) END, now() - make_interval(days => d, secs => g % 80000)
FROM (SELECT g, (CASE WHEN g % 10 < 3 THEN 20 + g % 60 ELSE g % 14 END)::int AS d FROM generate_series(1::bigint, 300000) g) s;
ANALYZE merchants, accounts, account_balances, transactions, holds, daily_merchant_rollups, notifications, notification_deliveries, reconciliation_exceptions, reconciliation_runs, idempotency_keys, outbox;
SELECT m.id AS probe_merchant, m.ref AS probe_ref FROM seed_merchants m WHERE m.n = 777 \gset
SELECT id AS big_merchant FROM seed_merchants WHERE n = 1 \gset
\echo
\echo '########## PART A: the required indexes (spec 9.2 rule 7) and the Phase 6 to 8 hot paths ##########'
\echo '== A1 Balances: account balances by code (accounts_environment_code_key, then the balance pkey)'
EXPLAIN (ANALYZE, BUFFERS) SELECT a.code, b.currency, b.posted_debits_minor, b.posted_credits_minor
  FROM account_balances b JOIN accounts a ON a.id = b.account_id
 WHERE a.environment = 'live' AND a.code = ANY (ARRAY['2000:merchant_payable:' || :'probe_ref', '2010:merchant_reserve:' || :'probe_ref']);
\echo '== A2 Balances: held amount (holds_merchant_active_idx, partial on state = active)'
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(amount_minor), 0) FROM holds
 WHERE merchant_id = :'probe_merchant' AND environment = 'live' AND currency = 'UGX' AND state = 'active';
\echo '== A3 Balances: pending amount (transactions_merchant_status_created_idx, 90-day bound)'
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(amount_minor), 0) FROM transactions
 WHERE merchant_id = :'probe_merchant' AND environment = 'live' AND currency = 'UGX' AND type = 'payment'
   AND status = 'processing' AND created_at >= now() - interval '90 days';
\echo '== A4 Balances: the big merchant (30,000 transactions) must not be slower'
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(amount_minor), 0) FROM transactions
 WHERE merchant_id = :'big_merchant' AND environment = 'live' AND currency = 'UGX' AND type = 'payment'
   AND status = 'processing' AND created_at >= now() - interval '90 days';
\echo '== A5 Transactions list, first page, 600k rows (transactions_merchant_created_idx)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM transactions
 WHERE merchant_id = :'big_merchant' AND environment = 'live' AND created_at >= now() - interval '90 days' AND created_at <= now()
 ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST LIMIT 26;
\echo '== A6 Dashboard overview: rollup series for one merchant, 30 days (daily_merchant_rollups unique index)'
EXPLAIN (ANALYZE, BUFFERS) SELECT date::text AS day, currency, sum(payment_count), sum(payment_minor), sum(success_count), sum(failure_count)
  FROM daily_merchant_rollups
 WHERE merchant_id = :'probe_merchant' AND environment = 'live' AND date >= now()::date - 29 AND date <= now()::date
 GROUP BY date, currency ORDER BY date;
\echo '== A7 Rollup recompute: one UTC day of final transactions, all merchants (the nightly aggregation)'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.merchant_id, t.environment, t.currency, t.channel, coalesce(t.provider, 'none'),
       count(*) FILTER (WHERE t.type = 'payment' AND t.status = 'succeeded'),
       coalesce(sum(t.amount_minor) FILTER (WHERE t.type = 'payment' AND t.status = 'succeeded'), 0)
  FROM transactions t
 WHERE t.created_at >= (now()::date - 1) - interval '35 days' AND t.created_at < now()::date
   AND t.status IN ('succeeded', 'failed', 'expired', 'cancelled')
   AND coalesce(t.completed_at, t.updated_at) >= (now()::date - 1) AND coalesce(t.completed_at, t.updated_at) < now()::date
 GROUP BY t.merchant_id, t.environment, t.currency, t.channel, coalesce(t.provider, 'none');
\echo '== A8 Settlement: period totals for one merchant (transactions_merchant_created_idx)'
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(amount_minor) FILTER (WHERE type = 'payment'), 0), coalesce(sum(fee_minor) FILTER (WHERE type = 'payment'), 0),
       coalesce(sum(amount_minor) FILTER (WHERE type = 'refund'), 0)
  FROM transactions
 WHERE created_at >= now() - interval '10 days' AND created_at < now() - interval '1 day'
   AND merchant_id = :'big_merchant' AND environment = 'live' AND currency = 'UGX' AND status = 'succeeded' AND type IN ('payment', 'refund')
   AND completed_at >= now() - interval '9 days' AND completed_at < now() - interval '1 day';
\echo '== A9 Settlement: active dispute and AML holds of a merchant (holds_merchant_active_idx)'
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(amount_minor) FILTER (WHERE reason LIKE 'dispute:%'), 0), coalesce(sum(amount_minor) FILTER (WHERE reason LIKE 'aml:%'), 0)
  FROM holds WHERE merchant_id = :'probe_merchant' AND environment = 'live' AND currency = 'UGX' AND state = 'active';
\echo '== A10 Hold expiry sweep (holds_expiry_idx, partial)'
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM holds WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= now() + interval '2 hours' ORDER BY expires_at LIMIT 200;
\echo '== A11 Reconciliation exception queue (reconciliation_exceptions_queue_idx, partial)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM reconciliation_exceptions WHERE status IN ('open', 'investigating') ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST LIMIT 51;
\echo '== A11 again, warm cache (the first run above reads cold pages the bulk seed left behind)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM reconciliation_exceptions WHERE status IN ('open', 'investigating') ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST LIMIT 51;
\echo '== A12 Reconciliation: open exception by dedupe key (partial unique index)'
EXPLAIN (ANALYZE, BUFFERS) UPDATE reconciliation_exceptions SET occurrences = occurrences + 1, last_seen_at = now()
 WHERE dedupe_key = 'dk-40' AND status IN ('open', 'investigating');
\echo '== A13 Reconciliation run by (kind, run key)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM reconciliation_runs WHERE kind = 'gateway_gap' AND run_key = 'rk-4000' FOR UPDATE;
\echo '== A14 Notifications: unread count (notifications_unread_idx, partial)'
SELECT recipient_id AS probe_recipient FROM notifications WHERE channel = 'in_app' AND read_at IS NULL LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM notifications WHERE recipient_id = :'probe_recipient' AND channel = 'in_app' AND read_at IS NULL;
\echo '== A15 Notifications: inbox page (notifications_inbox_idx)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM notifications WHERE recipient_id = :'probe_recipient' AND channel = 'in_app'
 ORDER BY created_at DESC, ref DESC LIMIT 26;
\echo '== A16 Notifications: dedupe lookup (notifications_dedupe_idx)'
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM notifications WHERE recipient_id = :'probe_recipient' AND template_code = 'payment.succeeded' AND resource_key = 'res-1' AND created_at >= now() - interval '5 minutes' LIMIT 1;
\echo '== A17 Notification delivery sweep: pending and overdue (per-partition partial indexes)'
EXPLAIN (ANALYZE, BUFFERS) SELECT id, created_at, attempts FROM notification_deliveries
 WHERE status = 'pending' AND created_at >= now() - interval '30 days' AND next_attempt_at <= now() - interval '60 seconds'
 ORDER BY next_attempt_at LIMIT 200;
\echo '== A18 AML velocity rebuild: live volume of one merchant in a window (transactions_merchant_status_created_idx)'
EXPLAIN (ANALYZE, BUFFERS) SELECT coalesce(sum(amount_minor), 0) FROM transactions
 WHERE created_at >= now() - interval '1 day' AND merchant_id = :'big_merchant' AND environment = 'live' AND currency = 'UGX' AND type = 'payment'
   AND status IN ('created', 'requires_action', 'processing', 'succeeded');
\echo '== A19 Suspense and negative-payable integrity: non-zero suspense balance'
EXPLAIN (ANALYZE, BUFFERS) SELECT a.environment, b.currency, (b.posted_debits_minor - b.posted_credits_minor) FROM account_balances b JOIN accounts a ON a.id = b.account_id
 WHERE a.purpose = 'suspense' AND b.posted_debits_minor <> b.posted_credits_minor;

\echo
-- Migration 0010 creates this index for real. To measure "before", the script drops it inside its own
-- transaction (rolled back at the end) and creates it again as the "after".
DROP INDEX IF EXISTS transactions_processing_idx;
\echo '########## PART B: stuck and stale transaction scans, before and after a candidate index ##########'
\echo 'The three scans filter transactions on status = processing across all merchants. No existing'
\echo 'index starts with status or serves them; each run reads every partition in its window.'
\echo '== B1 (before) Gateway-gap stale scan: processing payouts and refunds older than ten minutes'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.id, t.ref, t.type, t.merchant_id, t.provider, t.gateway_external_id, t.amount_minor, t.currency, t.outcome_unknown
  FROM transactions t
 WHERE t.created_at >= now() - interval '30 days' AND t.environment = 'live' AND t.status = 'processing' AND t.gateway_external_id IS NOT NULL
   AND t.type IN ('payout', 'refund') AND coalesce(t.initiated_at, t.created_at) <= now() - interval '10 minutes'
 ORDER BY coalesce(t.initiated_at, t.created_at), t.ref LIMIT 200;
\echo '== B2 (before) Stuck summary for the incident monitor and gauges'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.type, count(*), min(coalesce(t.initiated_at, t.created_at)) FROM transactions t
 WHERE t.created_at >= now() - interval '30 days' AND t.status = 'processing' AND coalesce(t.initiated_at, t.created_at) <= now() - interval '15 minutes' GROUP BY t.type;
\echo '== B3 (before) Stuck list, first page'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.ref, t.type, t.merchant_id FROM transactions t JOIN merchants m ON m.id = t.merchant_id
 WHERE t.created_at >= now() - interval '30 days' AND t.status = 'processing' AND coalesce(t.initiated_at, t.created_at) <= now() - interval '15 minutes'
 ORDER BY coalesce(t.initiated_at, t.created_at), t.ref LIMIT 51;
\echo '== candidate: CREATE INDEX transactions_processing_idx ON transactions (created_at) WHERE status = ''processing'''
CREATE INDEX transactions_processing_idx ON transactions (created_at) WHERE status = 'processing';
ANALYZE transactions;
SELECT pg_size_pretty(pg_total_relation_size('transactions_processing_idx')) AS candidate_index_size_parent_only;
\echo '== B1 (after)'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.id, t.ref, t.type, t.merchant_id, t.provider, t.gateway_external_id, t.amount_minor, t.currency, t.outcome_unknown
  FROM transactions t
 WHERE t.created_at >= now() - interval '30 days' AND t.environment = 'live' AND t.status = 'processing' AND t.gateway_external_id IS NOT NULL
   AND t.type IN ('payout', 'refund') AND coalesce(t.initiated_at, t.created_at) <= now() - interval '10 minutes'
 ORDER BY coalesce(t.initiated_at, t.created_at), t.ref LIMIT 200;
\echo '== B2 (after)'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.type, count(*), min(coalesce(t.initiated_at, t.created_at)) FROM transactions t
 WHERE t.created_at >= now() - interval '30 days' AND t.status = 'processing' AND coalesce(t.initiated_at, t.created_at) <= now() - interval '15 minutes' GROUP BY t.type;
\echo '== B3 (after)'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.ref, t.type, t.merchant_id FROM transactions t JOIN merchants m ON m.id = t.merchant_id
 WHERE t.created_at >= now() - interval '30 days' AND t.status = 'processing' AND coalesce(t.initiated_at, t.created_at) <= now() - interval '15 minutes'
 ORDER BY coalesce(t.initiated_at, t.created_at), t.ref LIMIT 51;

\echo
\echo '########## PART B2: the rollup recompute (A7) and an expression index on its filter ##########'
\echo 'A7 filters on coalesce(completed_at, updated_at); no index can serve that expression, so each'
\echo 'run reads the whole 35-day window. Candidate: an expression index limited to final rows.'
\echo '== candidate: CREATE INDEX transactions_final_day_idx ON transactions ((coalesce(completed_at, updated_at))) WHERE status IN (final states)'
CREATE INDEX transactions_final_day_idx ON transactions ((coalesce(completed_at, updated_at))) WHERE status IN ('succeeded', 'failed', 'expired', 'cancelled');
ANALYZE transactions;
\echo '== A7 (after) Rollup recompute with transactions_final_day_idx'
EXPLAIN (ANALYZE, BUFFERS) SELECT t.merchant_id, t.environment, t.currency, t.channel, coalesce(t.provider, 'none'),
       count(*) FILTER (WHERE t.type = 'payment' AND t.status = 'succeeded'),
       coalesce(sum(t.amount_minor) FILTER (WHERE t.type = 'payment' AND t.status = 'succeeded'), 0)
  FROM transactions t
 WHERE t.created_at >= (now()::date - 1) - interval '35 days' AND t.created_at < now()::date
   AND t.status IN ('succeeded', 'failed', 'expired', 'cancelled')
   AND coalesce(t.completed_at, t.updated_at) >= (now()::date - 1) AND coalesce(t.completed_at, t.updated_at) < now()::date
 GROUP BY t.merchant_id, t.environment, t.currency, t.channel, coalesce(t.provider, 'none');
\echo '== index sizes (all partitions)'
SELECT c.relname, pg_size_pretty(pg_relation_size(c.oid)) AS size FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
 WHERE c.relname LIKE 'transactions\_2%\_coalesce\_idx' OR c.relname LIKE 'transactions\_2%\_created\_at\_idx' ORDER BY 1;
SELECT pg_size_pretty(sum(pg_relation_size(t.oid))) AS transactions_heap_total FROM pg_class t WHERE t.relname LIKE 'transactions\_2%' AND t.relkind = 'r';

\echo
\echo '########## PART B3: what each candidate index costs on the write path ##########'
\echo 'Wall-clock timings on a shared development machine varied tenfold between identical runs, so this'
\echo 'part counts WAL bytes, which are deterministic: the full lifecycle of 50,000 payments (insert as'
\echo 'created, then processing, then succeeded), twice per series. A line "WAL_BYTES n" is one run.'
\echo 'Series: no candidate; only the partial processing index; only the final-state expression index.'
DROP INDEX transactions_processing_idx;
DROP INDEX transactions_final_day_idx;
ANALYZE transactions;
CREATE TEMP TABLE bench_ids ON COMMIT DROP AS SELECT gen_uuid_v7() AS id, gen_public_id('txn') AS ref, g, (SELECT id FROM seed_merchants WHERE n = 1 + g % 2000) AS merchant_id,
       now() - make_interval(secs => (g % 80000)::int) AS created_at FROM generate_series(1::bigint, 50000) g;
\echo '== B4 series 1: no candidate index'
SAVEPOINT b4;
SELECT pg_current_wal_lsn() AS lsn0 \gset
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, created_at) SELECT id, ref, merchant_id, 'live', 'payment', 'created', 1000, 0, 1000, 'UGX', 'mobile_money', created_at FROM bench_ids;
UPDATE transactions t SET status = 'processing', provider = 'mtn', initiated_at = t.created_at FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
UPDATE transactions t SET status = 'succeeded', completed_at = t.created_at + interval '30 seconds' FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn0') AS wal_bytes \gset
\echo WAL_BYTES :wal_bytes
ROLLBACK TO b4;
SAVEPOINT b4;
SELECT pg_current_wal_lsn() AS lsn0 \gset
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, created_at) SELECT id, ref, merchant_id, 'live', 'payment', 'created', 1000, 0, 1000, 'UGX', 'mobile_money', created_at FROM bench_ids;
UPDATE transactions t SET status = 'processing', provider = 'mtn', initiated_at = t.created_at FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
UPDATE transactions t SET status = 'succeeded', completed_at = t.created_at + interval '30 seconds' FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn0') AS wal_bytes \gset
\echo WAL_BYTES :wal_bytes
ROLLBACK TO b4;
CREATE INDEX transactions_processing_idx ON transactions (created_at) WHERE status = 'processing';
ANALYZE transactions;
\echo '== B4 series 2: only transactions_processing_idx'
SAVEPOINT b4;
SELECT pg_current_wal_lsn() AS lsn0 \gset
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, created_at) SELECT id, ref, merchant_id, 'live', 'payment', 'created', 1000, 0, 1000, 'UGX', 'mobile_money', created_at FROM bench_ids;
UPDATE transactions t SET status = 'processing', provider = 'mtn', initiated_at = t.created_at FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
UPDATE transactions t SET status = 'succeeded', completed_at = t.created_at + interval '30 seconds' FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn0') AS wal_bytes \gset
\echo WAL_BYTES :wal_bytes
ROLLBACK TO b4;
SAVEPOINT b4;
SELECT pg_current_wal_lsn() AS lsn0 \gset
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, created_at) SELECT id, ref, merchant_id, 'live', 'payment', 'created', 1000, 0, 1000, 'UGX', 'mobile_money', created_at FROM bench_ids;
UPDATE transactions t SET status = 'processing', provider = 'mtn', initiated_at = t.created_at FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
UPDATE transactions t SET status = 'succeeded', completed_at = t.created_at + interval '30 seconds' FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn0') AS wal_bytes \gset
\echo WAL_BYTES :wal_bytes
ROLLBACK TO b4;
DROP INDEX transactions_processing_idx;
CREATE INDEX transactions_final_day_idx ON transactions ((coalesce(completed_at, updated_at))) WHERE status IN ('succeeded', 'failed', 'expired', 'cancelled');
ANALYZE transactions;
\echo '== B4 series 3: only transactions_final_day_idx'
SAVEPOINT b4;
SELECT pg_current_wal_lsn() AS lsn0 \gset
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, created_at) SELECT id, ref, merchant_id, 'live', 'payment', 'created', 1000, 0, 1000, 'UGX', 'mobile_money', created_at FROM bench_ids;
UPDATE transactions t SET status = 'processing', provider = 'mtn', initiated_at = t.created_at FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
UPDATE transactions t SET status = 'succeeded', completed_at = t.created_at + interval '30 seconds' FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn0') AS wal_bytes \gset
\echo WAL_BYTES :wal_bytes
ROLLBACK TO b4;
SAVEPOINT b4;
SELECT pg_current_wal_lsn() AS lsn0 \gset
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, created_at) SELECT id, ref, merchant_id, 'live', 'payment', 'created', 1000, 0, 1000, 'UGX', 'mobile_money', created_at FROM bench_ids;
UPDATE transactions t SET status = 'processing', provider = 'mtn', initiated_at = t.created_at FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
UPDATE transactions t SET status = 'succeeded', completed_at = t.created_at + interval '30 seconds' FROM bench_ids b WHERE t.id = b.id AND t.created_at = b.created_at;
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :'lsn0') AS wal_bytes \gset
\echo WAL_BYTES :wal_bytes
ROLLBACK TO b4;

\echo
\echo '########## PART C: partition maintenance and retention (migration 0009, the lifecycle jobs) ##########'
\echo '== C1 Idempotency purge batch (idempotency_keys_expires_idx, SKIP LOCKED)'
EXPLAIN (ANALYZE, BUFFERS) WITH doomed AS (SELECT id FROM idempotency_keys WHERE expires_at < now() - interval '7 days' ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
  DELETE FROM idempotency_keys k USING doomed WHERE k.id = doomed.id;
\echo '== C2 Outbox purge batch: published rows older than 14 days, as a primary-key range (no new index)'
SELECT (to_hex((extract(epoch FROM now() - interval '14 days') * 1000)::bigint)) AS ms \gset
SELECT lpad(:'ms', 12, '0') AS hex12 \gset
SELECT substr(:'hex12', 1, 8) || '-' || substr(:'hex12', 9, 4) || '-0000-0000-000000000000' AS id_bound \gset
EXPLAIN (ANALYZE, BUFFERS) WITH doomed AS (SELECT id FROM outbox WHERE id < :'id_bound'::uuid AND published_at IS NOT NULL AND published_at < now() - interval '14 days' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED)
  DELETE FROM outbox o USING doomed WHERE o.id = doomed.id;
\echo '== C2b Steady state: after the backlog is gone, the next run finds nothing. With the id bound:'
DELETE FROM outbox WHERE id < :'id_bound'::uuid AND published_at IS NOT NULL AND published_at < now() - interval '14 days';
EXPLAIN (ANALYZE, BUFFERS) WITH doomed AS (SELECT id FROM outbox WHERE id < :'id_bound'::uuid AND published_at IS NOT NULL AND published_at < now() - interval '14 days' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED)
  DELETE FROM outbox o USING doomed WHERE o.id = doomed.id;
\echo '== C2c Steady state without the id bound (the naive form): it reads the whole primary key to learn there is nothing to do'
EXPLAIN (ANALYZE, BUFFERS) WITH doomed AS (SELECT id FROM outbox WHERE published_at IS NOT NULL AND published_at < now() - interval '14 days' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED)
  DELETE FROM outbox o USING doomed WHERE o.id = doomed.id;
\echo '== C3 Outbox claim with 300k rows, 1% unpublished (outbox_available_idx, partial)'
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM outbox WHERE published_at IS NULL AND available_at <= now() AND attempts < 10
   AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => 60)) ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED;
\echo '== C4 Partitions due for retention and partition status (catalogue reads)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM core.partitions_due_for_retention(now());
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM core.partition_status(now());
\echo '(second run, warm catalogue cache)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM core.partition_status(now());
\echo '== C5 Partition pruning: a 90-day transactions window reads only the partitions it spans'
EXPLAIN (COSTS OFF) SELECT count(*) FROM transactions WHERE created_at >= now() - interval '30 days' AND merchant_id = :'probe_merchant';
ROLLBACK;
