-- Phase 9: partial index for the stuck-transaction scans (docs/query-plans/phase9.txt, part B).
-- The gateway gap run, the incident monitor and the stuck list read `status = 'processing'` across
-- all merchants; no existing index serves them. Only in-flight rows are indexed.
--
-- DEPLOYMENT: a plain CREATE INDEX on a partitioned table takes a SHARE lock on every partition
-- while it builds, which stops writes to `transactions`. That is instant on a small table and not
-- acceptable on a large one. On a production database with more than about a million
-- transactions, create it without blocking BEFORE running this migration (docs/DEPLOYMENT.md,
-- "Large-table index procedure"); `IF NOT EXISTS` then makes this statement a no-op.
CREATE INDEX IF NOT EXISTS "transactions_processing_idx" ON "core"."transactions" USING btree ("created_at") WHERE "core"."transactions"."status" = 'processing';
