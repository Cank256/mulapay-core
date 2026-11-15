-- Phase 2 hot queries (spec 9.2 rule 7, section 16): the posting path, balance reads,
-- the merchant close check, and the journal access patterns the Phase 2 indexes serve.
-- Run against a database prepared with the bootstrap SQL and migrations; see
-- docs/query-plans/README.md.
--
-- Seeds synthetic rows through the real triggers (so balances and the key registry are
-- filled the production way), runs each query with EXPLAIN (ANALYZE, BUFFERS), then rolls
-- everything back. The deferred balance check never runs because nothing commits.
\set ON_ERROR_STOP on
\pset pager off
SET search_path = core;
BEGIN;
-- 2k merchants with their four accounts, then 100k two-line entries (200k lines) spread
-- over the merchants: DR provider clearing, CR merchant payable.
INSERT INTO merchants (id, ref, legal_name, country, default_currency, created_at)
SELECT gen_uuid_v7(), gen_public_id('mch'), 'Merchant ' || g, 'UG', 'UGX', now() - make_interval(mins => g)
FROM generate_series(1, 2000) g;
INSERT INTO accounts (id, ref, environment, code, name, type, normal_balance, merchant_id, purpose, is_system)
SELECT gen_uuid_v7(), gen_public_id('acct'), env, p.number || ':' || p.purpose || ':' || m.ref, p.purpose,
       'liability', 'credit', m.id, p.purpose, false
FROM merchants m
CROSS JOIN (VALUES ('test'), ('live')) e (env)
CROSS JOIN (VALUES ('2000', 'merchant_payable'), ('2010', 'merchant_reserve')) p (number, purpose);
CREATE TEMP TABLE seed_payables ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY id) AS n, id, merchant_id FROM accounts
WHERE environment = 'test' AND purpose = 'merchant_payable';
INSERT INTO journal_entries (id, ref, idempotency_key, request_fingerprint, environment, merchant_id, currency, kind, description, source, source_id, created_by)
SELECT gen_uuid_v7(), gen_public_id('je'), encode(sha256(('payment:' || g)::bytea), 'hex'),
       encode(sha256(g::text::bytea), 'hex'), 'test', p.merchant_id, 'UGX', 'collection.succeeded',
       'seed', 'payment', 'evt_' || g, 'system:seed'
FROM generate_series(1, 100000) g
JOIN seed_payables p ON p.n = 1 + g % 2000;
INSERT INTO journal_lines (entry_id, line_no, account_id, direction, amount_minor, currency)
SELECT e.id, l.line_no, CASE l.line_no WHEN 1 THEN c.id ELSE p.id END,
       CASE l.line_no WHEN 1 THEN 'debit' ELSE 'credit' END, 1000, 'UGX'
FROM journal_entries e
JOIN seed_payables p ON p.merchant_id = e.merchant_id
CROSS JOIN (SELECT id FROM accounts WHERE environment = 'test' AND code = '1000:provider_clearing:mtn') c
CROSS JOIN (VALUES (1), (2)) l (line_no)
WHERE e.description = 'seed';
ANALYZE merchants, accounts, account_balances, journal_entry_keys, journal_entries, journal_lines;

\echo '== Posting: idempotency key lookup (journal_entry_keys_pkey)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM journal_entry_keys WHERE idempotency_key = encode(sha256('payment:4242'::bytea), 'hex') LIMIT 1;

\echo '== Reversal: entry by public ref (journal_entry_keys_entry_ref_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM journal_entry_keys WHERE entry_ref = (SELECT entry_ref FROM journal_entry_keys OFFSET 500 LIMIT 1) LIMIT 1;

\echo '== Posting: resolve account codes (accounts_environment_code_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM accounts
WHERE environment = 'test'
  AND code IN ('1000:provider_clearing:mtn', '4000:fee_revenue', (SELECT code FROM accounts WHERE purpose = 'merchant_payable' LIMIT 1));

\echo '== Posting: lock balance rows in account id order (account_balances_account_id_currency_pk)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM account_balances
WHERE account_id IN (SELECT id FROM accounts WHERE environment = 'test' AND purpose = 'merchant_payable' LIMIT 3)
  AND currency = 'UGX'
ORDER BY account_id FOR UPDATE;

\echo '== Entry and lines by id and created_at, pruned to one partition (journal_entries / journal_lines pkeys)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT l.line_no, l.account_id, a.code, l.direction, l.amount_minor
FROM journal_lines l JOIN accounts a ON a.id = l.account_id
WHERE l.entry_id = (SELECT entry_id FROM journal_entry_keys OFFSET 700 LIMIT 1)
  AND l.created_at = (SELECT entry_created_at FROM journal_entry_keys OFFSET 700 LIMIT 1)
ORDER BY l.line_no;

\echo '== Merchant close: any non-zero live balance (accounts_merchant_idx, account_balances pkey)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT 1 FROM account_balances b JOIN accounts a ON a.id = b.account_id
WHERE a.merchant_id = (SELECT merchant_id FROM seed_payables WHERE n = 17)
  AND a.environment = 'live' AND b.posted_debits_minor <> b.posted_credits_minor
LIMIT 1;

\echo '== Merchant balances in one environment (accounts_merchant_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT a.id, a.code, a.purpose, a.normal_balance, b.currency, b.posted_debits_minor, b.posted_credits_minor
FROM account_balances b JOIN accounts a ON a.id = b.account_id
WHERE a.merchant_id = (SELECT merchant_id FROM seed_payables WHERE n = 17) AND a.environment = 'test'
ORDER BY a.code, b.currency;

\echo '== Account lines, newest first, 90-day window (journal_lines_account_created_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT entry_id, line_no, direction, amount_minor, created_at FROM journal_lines
WHERE account_id = (SELECT id FROM seed_payables WHERE n = 17)
  AND created_at >= now() - interval '90 days' AND created_at < now() + interval '1 second'
ORDER BY created_at DESC LIMIT 25;

\echo '== Merchant lines, newest first, 90-day window (journal_lines_merchant_created_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT entry_id, line_no, account_id, direction, amount_minor, created_at FROM journal_lines
WHERE merchant_id = (SELECT merchant_id FROM seed_payables WHERE n = 17)
  AND created_at >= now() - interval '90 days' AND created_at < now() + interval '1 second'
ORDER BY created_at DESC LIMIT 25;

\echo '== Integrity: invalid entries in a 1-day window (partition pruning; a scan of the window by design)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT e.ref, count(l.entry_id)
FROM journal_entries e
LEFT JOIN journal_lines l ON l.entry_id = e.id AND l.created_at = e.created_at
 AND l.created_at >= now() - interval '1 day' AND l.created_at < now() + interval '1 second'
WHERE e.created_at >= now() - interval '1 day' AND e.created_at < now() + interval '1 second'
GROUP BY e.id, e.created_at, e.ref
HAVING count(l.entry_id) < 2
    OR coalesce(sum(l.amount_minor) FILTER (WHERE l.direction = 'debit'), 0)
       <> coalesce(sum(l.amount_minor) FILTER (WHERE l.direction = 'credit'), 0)
LIMIT 1000;

ROLLBACK;
