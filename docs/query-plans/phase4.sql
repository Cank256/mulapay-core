-- Phase 4 hot queries for payments and transactions (spec 9.2 rule 7, section 16): reading a
-- payment, the merchant lists, the lookups by public ref and by reference, the timeline, the
-- idempotency claim, the event dedupe check, the expiry sweep, and the payment link and
-- checkout session access patterns. Run against a database prepared with the bootstrap SQL
-- and migrations; see docs/query-plans/README.md.
--
-- Seeds synthetic rows through the real insert triggers (so the transaction registry is
-- filled the production way), moves each payment through its legal statuses, runs each query
-- with EXPLAIN (ANALYZE, BUFFERS), then rolls everything back. The deferred agreement check
-- never runs because nothing commits.
\set ON_ERROR_STOP on
\pset pager off
SET search_path = core;
BEGIN;
SET LOCAL statement_timeout = 0;
-- Partitions for the three months before the migration ran, so a 90-day window is spread over
-- real partitions rather than the default one. The rollback removes them.
SELECT create_monthly_partitions('transactions', (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '3 months')::date, 3, false);
-- 2k merchants and 60k payments: 30 each, spread over the last 80 days, 70% succeeded, 20%
-- failed, 6% processing, 4% created. `big` is one merchant with 6,000 of them.
INSERT INTO merchants (id, ref, legal_name, country, default_currency, created_at)
SELECT gen_uuid_v7(), gen_public_id('mch'), 'Merchant ' || g, 'UG', 'UGX', now() - make_interval(mins => g)
FROM generate_series(1, 2000) g;
CREATE TEMP TABLE seed_merchants ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY ref) AS n, id FROM merchants;
CREATE TEMP TABLE seed_payments ON COMMIT DROP AS
SELECT g,
       gen_uuid_v7() AS transaction_id, gen_uuid_v7() AS payment_id,
       gen_public_id('txn') AS transaction_ref, gen_public_id('pay') AS payment_ref,
       CASE WHEN g <= 6000 THEN (SELECT id FROM seed_merchants WHERE n = 1) ELSE m.id END AS merchant_id,
       date_trunc('milliseconds', now() - make_interval(secs => (g * 7919) % (80 * 86400))) AS created_at,
       CASE WHEN g % 100 < 70 THEN 'succeeded' WHEN g % 100 < 90 THEN 'failed' WHEN g % 100 < 96 THEN 'processing' ELSE 'created' END AS final_status
FROM generate_series(1, 60000) g
JOIN seed_merchants m ON m.n = 1 + g % 2000;
INSERT INTO transactions (id, ref, merchant_id, environment, type, status, amount_minor, fee_minor, net_minor, currency, channel, gateway_external_id, created_at)
SELECT transaction_id, transaction_ref, merchant_id, 'test', 'payment', 'created', 1000 + g % 9000, 0, 1000 + g % 9000, 'UGX', 'mobile_money', payment_ref, created_at
FROM seed_payments;
INSERT INTO payments (id, ref, transaction_id, merchant_id, environment, amount_minor, currency, status, channel, idempotency_key, expires_at, created_at)
SELECT payment_id, payment_ref, transaction_id, merchant_id, 'test', 1000 + g % 9000, 'UGX', 'created', 'mobile_money', 'seed-' || g, created_at + interval '15 minutes', created_at
FROM seed_payments;
-- created -> processing for everything but the 4% that stay created.
UPDATE transactions t SET status = 'processing', provider = CASE WHEN s.g % 2 = 0 THEN 'mtn' ELSE 'airtel' END,
       provider_transaction_id = 'ptx-' || s.g, initiated_at = t.created_at
FROM seed_payments s WHERE t.id = s.transaction_id AND t.created_at = s.created_at AND s.final_status <> 'created';
UPDATE payments p SET status = 'processing' FROM seed_payments s WHERE p.id = s.payment_id AND s.final_status <> 'created';
UPDATE transactions t SET status = s.final_status, completed_at = t.created_at + interval '30 seconds',
       failure_code = CASE s.final_status WHEN 'failed' THEN 'declined' END
FROM seed_payments s WHERE t.id = s.transaction_id AND t.created_at = s.created_at AND s.final_status IN ('succeeded', 'failed');
UPDATE payments p SET status = s.final_status FROM seed_payments s WHERE p.id = s.payment_id AND s.final_status IN ('succeeded', 'failed');
-- Two events per payment (created, processing) and a third for the finished ones.
INSERT INTO transaction_events (id, transaction_id, merchant_id, environment, event_key, source, outcome, from_status, to_status, occurred_at, created_at)
SELECT gen_uuid_v7(), s.transaction_id, s.merchant_id, 'test', 'created', 'api', 'applied', NULL, 'created', s.created_at, s.created_at FROM seed_payments s
UNION ALL
SELECT gen_uuid_v7(), s.transaction_id, s.merchant_id, 'test', 'evt-' || s.g || '-1', 'gateway_event', 'applied', 'created', 'processing', s.created_at, s.created_at
FROM seed_payments s WHERE s.final_status <> 'created'
UNION ALL
SELECT gen_uuid_v7(), s.transaction_id, s.merchant_id, 'test', 'evt-' || s.g || '-2', 'gateway_event', 'applied', 'processing', s.final_status, s.created_at, s.created_at
FROM seed_payments s WHERE s.final_status IN ('succeeded', 'failed');
INSERT INTO payment_links (id, ref, merchant_id, environment, amount_minor, currency, title, slug, max_uses, created_at)
SELECT gen_uuid_v7(), gen_public_id('pl'), m.id, 'test', 5000, 'UGX', 'Link ' || g,
       substr(md5(g::text), 1, 12), 100, now() - make_interval(mins => g)
FROM generate_series(1, 20000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
INSERT INTO checkout_sessions (id, ref, merchant_id, environment, status, amount_minor, currency, expires_at, client_secret_hash, created_at)
SELECT gen_uuid_v7(), gen_public_id('cs'), m.id, 'test', CASE WHEN g % 10 = 0 THEN 'open' ELSE 'expired' END, 5000, 'UGX',
       now() + make_interval(mins => g % 1000) - interval '300 minutes', repeat('a', 64), now() - make_interval(mins => g)
FROM generate_series(1, 20000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
INSERT INTO idempotency_keys (id, merchant_id, environment, scope, key, request_fingerprint, status, response_status, response_body, locked_at, expires_at)
SELECT gen_uuid_v7(), m.id, 'test', 'payments.create', 'idem-' || g, repeat('b', 64), 'completed', 201, '{}'::jsonb, now(), now() + interval '1 day'
FROM generate_series(1, 60000) g JOIN seed_merchants m ON m.n = 1 + g % 2000;
ANALYZE merchants, transaction_keys, transactions, payments, transaction_events, payment_links, checkout_sessions, idempotency_keys;
-- A merchant with 30 payments, and the big one with 6,000.
CREATE TEMP TABLE probe ON COMMIT DROP AS
SELECT (SELECT merchant_id FROM seed_payments WHERE g = 2500) AS merchant_id,
       (SELECT id FROM seed_merchants WHERE n = 1) AS big_merchant_id,
       (SELECT payment_ref FROM seed_payments WHERE g = 2500) AS payment_ref,
       (SELECT transaction_ref FROM seed_payments WHERE g = 2500) AS transaction_ref,
       (SELECT transaction_id FROM seed_payments WHERE g = 2500) AS transaction_id,
       (SELECT created_at FROM seed_payments WHERE g = 2500) AS created_at;
\echo '== Payment by public ref, with its transaction (payments_ref_key, then transactions pkey; other partitions pruned at run time)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT p.*, t.*, pl.ref, cs.ref
FROM payments p
JOIN transactions t ON t.id = p.transaction_id AND t.created_at = p.created_at
LEFT JOIN payment_links pl ON pl.id = p.payment_link_id
LEFT JOIN checkout_sessions cs ON cs.id = p.checkout_session_id
WHERE p.ref = (SELECT payment_ref FROM probe) AND p.merchant_id = (SELECT merchant_id FROM probe) AND p.environment = 'test'
LIMIT 1;
SELECT (now() - interval '40 days')::text AS cursor_at \gset
\echo '== Payments list, newest first, first page (payments_merchant_created_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT p.*, t.*, pl.ref, cs.ref
FROM payments p
JOIN transactions t ON t.id = p.transaction_id AND t.created_at = p.created_at
LEFT JOIN payment_links pl ON pl.id = p.payment_link_id
LEFT JOIN checkout_sessions cs ON cs.id = p.checkout_session_id
WHERE p.merchant_id = (SELECT big_merchant_id FROM probe) AND p.environment = 'test'
  AND p.created_at >= now() - interval '90 days' AND p.created_at <= now()
ORDER BY p.created_at DESC NULLS LAST, p.ref DESC NULLS LAST
LIMIT 26;
\echo '== Payments list, keyset page 2 (payments_merchant_created_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT p.*, t.*
FROM payments p
JOIN transactions t ON t.id = p.transaction_id AND t.created_at = p.created_at
WHERE p.merchant_id = (SELECT big_merchant_id FROM probe) AND p.environment = 'test'
  AND p.created_at >= now() - interval '90 days' AND p.created_at <= now()
  AND p.created_at <= :'cursor_at'::timestamptz AND (p.created_at < :'cursor_at'::timestamptz OR (p.created_at = :'cursor_at'::timestamptz AND p.ref < 'pay_Z'))
ORDER BY p.created_at DESC NULLS LAST, p.ref DESC NULLS LAST
LIMIT 26;
\echo '== Transactions list, 90-day window, first page (transactions_merchant_created_idx per partition)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transactions
WHERE merchant_id = (SELECT big_merchant_id FROM probe) AND environment = 'test'
  AND created_at >= now() - interval '90 days' AND created_at <= now()
ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST
LIMIT 26;
\echo '== Transactions list, keyset page 2 (range on created_at plus a residual test on ref; Merge Append stops at the LIMIT)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transactions
WHERE merchant_id = (SELECT big_merchant_id FROM probe) AND environment = 'test'
  AND created_at >= now() - interval '90 days' AND created_at <= now()
  AND created_at <= :'cursor_at'::timestamptz AND (created_at < :'cursor_at'::timestamptz OR (created_at = :'cursor_at'::timestamptz AND ref < 'txn_Z'))
ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST
LIMIT 26;
\echo '== Transactions list filtered by status (transactions_merchant_status_created_idx per partition)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transactions
WHERE merchant_id = (SELECT big_merchant_id FROM probe) AND environment = 'test' AND status = 'failed'
  AND created_at >= now() - interval '90 days' AND created_at <= now()
ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST
LIMIT 26;
\echo '== Transactions list for a small merchant over 90 days'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transactions
WHERE merchant_id = (SELECT merchant_id FROM probe) AND environment = 'test'
  AND created_at >= now() - interval '90 days' AND created_at <= now()
ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST
LIMIT 26;
\echo '== Transactions list by reference: ref, external id or provider transaction id'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transactions
WHERE merchant_id = (SELECT merchant_id FROM probe) AND environment = 'test'
  AND created_at >= now() - interval '90 days' AND created_at <= now()
  AND (ref = (SELECT payment_ref FROM probe) OR gateway_external_id = (SELECT payment_ref FROM probe) OR provider_transaction_id = (SELECT payment_ref FROM probe))
ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST
LIMIT 26;
\echo '== Transaction by public ref through the registry (transaction_keys_ref_key, then one partition by primary key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT t.* FROM transaction_keys k
JOIN transactions t ON t.id = k.id AND t.created_at = k.transaction_created_at
WHERE k.ref = (SELECT transaction_ref FROM probe) AND k.merchant_id = (SELECT merchant_id FROM probe) AND k.environment = 'test'
LIMIT 1;
\echo '== Lock a transaction by (id, created_at) for a lifecycle step (primary key, one partition)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transactions WHERE id = (SELECT transaction_id FROM probe) AND created_at = (SELECT created_at FROM probe) FOR UPDATE;
\echo '== Lock a payment by id for a lifecycle step (payments_pkey)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM payments WHERE id = (SELECT id FROM payments WHERE ref = (SELECT payment_ref FROM probe)) FOR UPDATE;
\echo '== Timeline of one transaction (transaction_events_transaction_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transaction_events
WHERE transaction_id = (SELECT transaction_id FROM probe) AND merchant_id = (SELECT merchant_id FROM probe) AND environment = 'test'
ORDER BY created_at, id LIMIT 200;
\echo '== Event dedupe: has this event key been applied (transaction_events_key_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM transaction_events WHERE transaction_id = (SELECT transaction_id FROM probe) AND event_key = 'created' LIMIT 1;
\echo '== Idempotency claim: conflict check on the key (idempotency_keys_key_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM idempotency_keys
WHERE merchant_id = (SELECT merchant_id FROM probe) AND environment = 'test' AND scope = 'payments.create' AND key = 'idem-2500';
\echo '== Expiry sweep: unsubmitted payments past their expiry (payments_created_expiry_idx, partial)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id FROM payments WHERE status = 'created' AND expires_at <= now() ORDER BY expires_at LIMIT 100;
\echo '== Checkout session sweep: open sessions past their expiry (checkout_sessions_open_expiry_idx, partial)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM checkout_sessions WHERE status = 'open' AND expires_at <= now() ORDER BY expires_at LIMIT 100;
\echo '== Payment link: take one use by ref (payment_links_ref_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id FROM payment_links
WHERE ref = (SELECT ref FROM payment_links LIMIT 1 OFFSET 700) AND active AND (expires_at IS NULL OR expires_at > now()) AND (max_uses IS NULL OR used_count < max_uses);
\echo '== Payment link by public slug (payment_links_slug_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM payment_links WHERE slug = substr(md5('700'), 1, 12);
\echo '== Payment links list, newest first (payment_links_merchant_created_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM payment_links
WHERE merchant_id = (SELECT merchant_id FROM probe) AND environment = 'test'
ORDER BY created_at DESC NULLS LAST, ref DESC NULLS LAST LIMIT 26;
\echo '== Checkout session by ref (checkout_sessions_ref_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT s.*, p.ref FROM checkout_sessions s LEFT JOIN payments p ON p.id = s.payment_id
WHERE s.ref = (SELECT ref FROM checkout_sessions LIMIT 1 OFFSET 900) AND s.merchant_id = (SELECT merchant_id FROM checkout_sessions LIMIT 1 OFFSET 900) AND s.environment = 'test';
ROLLBACK;
