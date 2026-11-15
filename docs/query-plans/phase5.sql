-- Phase 5 hot queries for the developer platform (spec 9.2 rule 7, section 16): API key
-- authentication, the outbox claim, webhook fan-out and the pending-delivery sweep, the delivery
-- and event lists and lookups, the request log lists and the holds list. Run against a database
-- prepared with the bootstrap SQL and migrations; see docs/query-plans/README.md.
--
-- Seeds synthetic rows (through the real guard triggers), runs each query with EXPLAIN
-- (ANALYZE, BUFFERS), then rolls everything back.
\set ON_ERROR_STOP on
\pset pager off
SET search_path = core;
BEGIN;
SET LOCAL statement_timeout = 0;
-- Partitions for the three months before the migration ran, so a 90-day window spreads over
-- real partitions. The rollback removes them.
SELECT create_monthly_partitions('webhook_deliveries', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '3 months')::date, 3, false);
SELECT create_monthly_partitions('api_request_logs', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '3 months')::date, 3, true);
-- 2k merchants, one key each plus 18 more for 20 merchants; 20k endpoints; 100k events;
-- 200k deliveries; 200k request logs; 60k outbox rows; 20k holds.
INSERT INTO merchants (id, ref, legal_name, country, default_currency, created_at)
SELECT gen_uuid_v7(), gen_public_id('mch'), 'Merchant ' || g, 'UG', 'UGX', now() - make_interval(mins => g)
FROM generate_series(1, 2000) g;
CREATE TEMP TABLE seed_merchants ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY ref) AS n, id FROM merchants;
INSERT INTO api_keys (id, ref, merchant_id, environment, key_id, secret_hash, name, scopes)
SELECT gen_uuid_v7(), gen_public_id('ak'), m.id, CASE WHEN g % 2 = 0 THEN 'test' ELSE 'live' END,
       substr(md5('key' || g), 1, 16), md5('s' || g) || md5('t' || g), 'key ' || g, ARRAY['payments:read']
FROM generate_series(1, 40000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
INSERT INTO webhook_endpoints (id, ref, merchant_id, environment, url, enabled_events, secret_enc, status, disabled_at)
SELECT gen_uuid_v7(), gen_public_id('wh'), m.id, CASE WHEN g % 2 = 0 THEN 'test' ELSE 'live' END,
       'https://example.com/hook/' || g, ARRAY['*'], 'v1.x.y.z.w',
       CASE WHEN g % 10 = 0 THEN 'disabled' ELSE 'active' END,
       CASE WHEN g % 10 = 0 THEN now() END
FROM generate_series(1, 20000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
CREATE TEMP TABLE seed_events ON COMMIT DROP AS
SELECT g, gen_uuid_v7() AS id, gen_public_id('evt') AS ref, m.id AS merchant_id,
       CASE WHEN g % 2 = 0 THEN 'test' ELSE 'live' END AS environment,
       date_trunc('milliseconds', now() - make_interval(secs => (g * 7919) % (80 * 86400))) AS created_at
FROM generate_series(1, 100000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
INSERT INTO merchant_events (id, ref, merchant_id, environment, type, resource_type, resource_id, payload, created_at)
SELECT id, ref, merchant_id, environment, 'payment.created', 'payment', 'pay_' || g, '{"object":{}}', created_at FROM seed_events;
-- Deliveries go through the guard trigger, so each needs an endpoint of the same merchant and
-- environment: pick the merchant's first endpoint of the event's environment.
CREATE TEMP TABLE seed_endpoint ON COMMIT DROP AS
SELECT DISTINCT ON (merchant_id, environment) merchant_id, environment, id FROM webhook_endpoints ORDER BY merchant_id, environment, ref;
INSERT INTO webhook_deliveries (id, ref, endpoint_id, merchant_id, environment, event_id, event_type, dedupe_key, attempt, status, next_attempt_at, created_at)
SELECT gen_uuid_v7(), gen_public_id('whd'), ep.id, e.merchant_id, e.environment, e.id, 'payment.created',
       ep.id || ':' || e.id || ':original', 0, 'pending', e.created_at, e.created_at
FROM seed_events e JOIN seed_endpoint ep ON ep.merchant_id = e.merchant_id AND ep.environment = e.environment
WHERE e.g <= 100000;
UPDATE webhook_deliveries SET status = 'succeeded', attempt = 1, next_attempt_at = NULL
WHERE mod(('x' || substr(md5(ref), 1, 6))::bit(24)::int, 100) < 95;
INSERT INTO api_request_logs (id, ref, merchant_id, environment, api_key_id, method, path, route, status_code, latency_ms, request_id, created_at)
SELECT gen_uuid_v7(), gen_public_id('rl'), k.merchant_id, k.environment, k.id, 'GET', '/v1/payments', '/v1/payments',
       CASE WHEN g % 20 = 0 THEN 404 ELSE 200 END, g % 90, 'req-' || g,
       date_trunc('milliseconds', now() - make_interval(secs => (g * 7919) % (80 * 86400)))
FROM generate_series(1, 200000) g JOIN (SELECT row_number() OVER (ORDER BY ref) AS n, id, merchant_id, environment FROM api_keys) k ON k.n = 1 + g % 40000;
INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at, locked_at, published_at)
SELECT gen_uuid_v7(), 'merchant_event', g::text, CASE WHEN g % 10 = 0 THEN 'sandbox.payment_created' ELSE 'merchant_event.created' END,
       '{}', 'seed:' || g, now() - make_interval(secs => g % 3600), CASE WHEN g % 100 < 99 THEN now() END,
       CASE WHEN g % 100 < 99 THEN now() END
FROM generate_series(1, 60000) g;
ANALYZE;

\echo '== API key authentication by key_id, with its merchant'
SELECT key_id AS probe_key FROM api_keys ORDER BY ref LIMIT 1 OFFSET 777 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT k.*, m.ref, m.status FROM api_keys k JOIN merchants m ON m.id = k.merchant_id WHERE k.key_id = :'probe_key' LIMIT 1;

\echo '== Outbox claim: due, unpublished rows with a handler, SKIP LOCKED'
EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM outbox
 WHERE published_at IS NULL AND available_at <= now() AND attempts < 10
   AND event_type IN ('merchant_event.created', 'webhook.delivery_created', 'sandbox.payment_created')
   AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => 60))
 ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED;

\echo '== Fan-out: active endpoints of a merchant and environment'
SELECT merchant_id AS probe_merchant FROM webhook_endpoints WHERE environment = 'test' ORDER BY ref LIMIT 1 OFFSET 99 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM webhook_endpoints
 WHERE merchant_id = :'probe_merchant' AND environment = 'test' AND status = 'active' AND deleted_at IS NULL;

\echo '== Event feed: first page for a merchant, 90-day window'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM merchant_events
 WHERE merchant_id = :'probe_merchant' AND environment = 'test' AND created_at >= now() - interval '90 days' AND created_at <= now()
 ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST LIMIT 26;

\echo '== Event by ref'
SELECT ref AS probe_event FROM merchant_events WHERE merchant_id = :'probe_merchant' LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM merchant_events WHERE merchant_id = :'probe_merchant' AND environment = 'test' AND ref = :'probe_event' LIMIT 1;

\echo '== Pending deliveries overdue by a minute (recovery sweep)'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM webhook_deliveries
 WHERE created_at >= now() - interval '30 days' AND status = 'pending' AND next_attempt_at <= now() - interval '60 seconds'
 ORDER BY next_attempt_at LIMIT 200;

\echo '== Delivery by ref: the ref carries its created_at, so one partition is read'
SELECT ref AS probe_delivery, created_at AS probe_created FROM webhook_deliveries ORDER BY ref LIMIT 1 OFFSET 5000 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM webhook_deliveries WHERE created_at = :'probe_created' AND ref = :'probe_delivery' LIMIT 1;

\echo '== Delivery lease (the UPDATE of one pending delivery)'
EXPLAIN (ANALYZE, BUFFERS) UPDATE webhook_deliveries SET locked_until = now() + interval '30 seconds'
 WHERE created_at = :'probe_created' AND ref = :'probe_delivery' AND status = 'pending' AND next_attempt_at <= now() AND (locked_until IS NULL OR locked_until < now());

\echo '== Fan-out dedupe lookup'
SELECT dedupe_key AS probe_dedupe, created_at AS probe_dedupe_at FROM webhook_deliveries ORDER BY ref LIMIT 1 OFFSET 9000 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM webhook_deliveries WHERE dedupe_key = :'probe_dedupe' AND created_at = :'probe_dedupe_at' LIMIT 1;

\echo '== Delivery log, first page, 90-day window'
SELECT merchant_id AS probe_dmerchant FROM webhook_deliveries GROUP BY 1 ORDER BY count(*) DESC LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM webhook_deliveries
 WHERE merchant_id = :'probe_dmerchant' AND environment = 'test' AND created_at >= now() - interval '90 days' AND created_at <= now()
 ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST LIMIT 26;

\echo '== Request logs, first page, 90-day window'
SELECT merchant_id AS probe_lmerchant, environment AS probe_lenv FROM api_request_logs GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT l.*, k.ref FROM api_request_logs l JOIN api_keys k ON k.id = l.api_key_id
 WHERE l.merchant_id = :'probe_lmerchant' AND l.environment = :'probe_lenv' AND l.created_at >= now() - interval '90 days' AND l.created_at <= now()
 ORDER BY l.created_at DESC NULLS LAST, l.ref DESC NULLS LAST LIMIT 26;

\echo '== Request logs by request id'
SELECT request_id AS probe_request FROM api_request_logs WHERE merchant_id = :'probe_lmerchant' LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM api_request_logs
 WHERE merchant_id = :'probe_lmerchant' AND environment = :'probe_lenv' AND request_id = :'probe_request' AND created_at >= now() - interval '90 days' AND created_at <= now()
 ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST LIMIT 26;

ROLLBACK;
