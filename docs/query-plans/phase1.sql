-- Phase 1 hot queries (spec 9.2 rule 7, section 16). Run against a database prepared
-- with the bootstrap SQL and migrations; see docs/query-plans/README.md.
--
-- Seeds synthetic rows so the planner has realistic statistics, runs each query with
-- EXPLAIN (ANALYZE, BUFFERS), then rolls everything back.
\set ON_ERROR_STOP on
\pset pager off
SET search_path = core;
BEGIN;

-- 20k merchants, 60k users (3 members each), 200k sessions, 40k API keys, 200k audit rows.
INSERT INTO merchants (id, ref, legal_name, country, default_currency, status, created_at)
SELECT gen_random_uuid(), 'mch_' || lpad(g::text, 26, '0'), 'Merchant ' || g, 'UG', 'UGX',
       (ARRAY['draft','pending_kyc','active','suspended','closed'])[1 + g % 5],
       now() - make_interval(mins => g)
FROM generate_series(1, 20000) g;

INSERT INTO users (id, ref, type, email, password_hash, name)
SELECT gen_random_uuid(), 'usr_' || lpad(g::text, 26, '0'), 'merchant_user', 'user' || g || '@example.com', 'x', 'User ' || g
FROM generate_series(1, 60000) g;

INSERT INTO merchant_members (id, merchant_id, user_id, role, joined_at)
SELECT gen_random_uuid(), m.id, u.id, CASE WHEN u.n % 3 = 1 THEN 'owner' ELSE 'viewer' END, now()
FROM (SELECT id, row_number() OVER (ORDER BY ref) AS n FROM users) u
JOIN (SELECT id, row_number() OVER (ORDER BY ref) AS n FROM merchants) m ON m.n = (u.n + 2) / 3;

INSERT INTO sessions (id, family_id, user_id, merchant_id, surface, refresh_token_hash, amr, mfa, auth_time, expires_at, revoked_at, revoked_reason)
SELECT gen_random_uuid(), 'ses_' || lpad((g / 4)::text, 26, '0'), u.id, mm.merchant_id, 'dashboard',
       encode(sha256(g::text::bytea), 'hex'), '{pwd}', false, now(), now() + interval '30 days',
       CASE WHEN g % 4 = 0 THEN NULL ELSE now() END, CASE WHEN g % 4 = 0 THEN NULL ELSE 'rotated' END
FROM generate_series(1, 200000) g
JOIN LATERAL (SELECT id FROM users OFFSET (g % 60000) LIMIT 1) u ON true
JOIN merchant_members mm ON mm.user_id = u.id;

INSERT INTO api_keys (id, ref, merchant_id, environment, key_id, secret_hash, name, scopes, created_at)
SELECT gen_random_uuid(), 'ak_' || lpad(g::text, 26, '0'), m.id, 'test', lpad(to_hex(g), 16, '0'),
       encode(sha256(g::text::bytea), 'hex'), 'key ' || g, '{payments:read}', now()
FROM generate_series(1, 40000) g
JOIN LATERAL (SELECT id FROM merchants OFFSET (g % 20000) LIMIT 1) m ON true;

INSERT INTO audit_logs (seq, actor_type, actor_id, merchant_id, action, resource_type, resource_id, changed_fields, outcome, prev_hash, hash, created_at)
SELECT g, 'user', 'usr_x', m.id, 'merchant.updated', 'merchant', 'mch_x', '{}', 'success',
       repeat('0', 64), repeat('a', 64), now() - make_interval(mins => g)
FROM generate_series(1, 200000) g
JOIN LATERAL (SELECT id FROM merchants OFFSET (g % 20000) LIMIT 1) m ON true;

ANALYZE merchants, users, merchant_members, sessions, api_keys, audit_logs;

\echo '== API key authentication (api_keys_key_id_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT k.*, m.ref, m.status FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
WHERE k.key_id = lpad(to_hex(1234), 16, '0') LIMIT 1;

\echo '== Dashboard principal resolution, every request (users_ref_key, merchants_ref_key, merchant_members_merchant_user_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT u.id, m.id, mm.role FROM merchant_members mm
JOIN users u ON u.id = mm.user_id JOIN merchants m ON m.id = mm.merchant_id
WHERE mm.status = 'active' AND u.ref = 'usr_' || lpad('4000', 26, '0') AND m.ref = 'mch_' || lpad('1334', 26, '0')
ORDER BY mm.joined_at LIMIT 1;

\echo '== Refresh-token rotation (sessions_refresh_token_hash_key)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
UPDATE sessions SET revoked_at = now(), revoked_reason = 'rotated'
WHERE refresh_token_hash = encode(sha256('400'::bytea), 'hex') AND revoked_at IS NULL AND expires_at > now()
RETURNING id;

\echo '== Active sessions of a user (sessions_user_active_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM sessions s
WHERE s.user_id = (SELECT id FROM users WHERE ref = 'usr_' || lpad('100', 26, '0'))
  AND s.surface = 'dashboard' AND s.revoked_at IS NULL AND s.expires_at > now()
ORDER BY s.created_at DESC LIMIT 100;

\echo '== Session family revocation (sessions_family_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout'
WHERE family_id = 'ses_' || lpad('100', 26, '0') AND revoked_at IS NULL;

\echo '== Merchant API key list (api_keys_merchant_revoked_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM api_keys WHERE merchant_id = (SELECT id FROM merchants WHERE ref = 'mch_' || lpad('77', 26, '0'))
ORDER BY created_at DESC LIMIT 200;

\echo '== Admin merchant list, keyset page 2 (merchants_status_created_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM merchants
WHERE status = 'active' AND (created_at < now() - interval '1000 minutes'
   OR (created_at = now() - interval '1000 minutes' AND ref < 'mch_' || lpad('1000', 26, '0')))
ORDER BY created_at DESC, ref DESC LIMIT 26;

\echo '== Admin audit list for a merchant, 90-day window (partition pruning, audit_logs_merchant_created_idx)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT * FROM audit_logs
WHERE created_at >= now() - interval '90 days' AND created_at <= now()
  AND merchant_id = (SELECT id FROM merchants WHERE ref = 'mch_' || lpad('5', 26, '0'))
ORDER BY created_at DESC, seq DESC LIMIT 26;

ROLLBACK;
