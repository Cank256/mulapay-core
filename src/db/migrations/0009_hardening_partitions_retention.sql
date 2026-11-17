-- Phase 9 (hardening): partition automation and retention (spec 5.1 and 11).
--
-- Hand-written (drizzle-kit cannot express functions). Everything here is additive: no existing
-- table, trigger or grant changes.
--
-- Rules the database enforces, so a bug in the scheduler cannot break them:
--  * Retention applies only to the tables the specification lists (spec 11). The CHECK on
--    `partition_policies` rejects a retention period on the ledger, the audit log or
--    transactions, whatever the application sends.
--  * `drop_partition` re-checks every condition itself: policy, age, bounds, safety. It is the only
--    door to a DROP, and it refuses the default partition.
--  * A month's partition is never created over rows already in the default partition: those
--    rows may be append-only, so they cannot be moved. The condition is reported, not "fixed".
CREATE TABLE core.partition_policies (
  parent text PRIMARY KEY,
  -- Privileges revoked from the application role on every partition (they are checked per
  -- partition when a partition is addressed directly). Validated: it is spliced into a statement.
  revoked_privileges text NOT NULL,
  -- NULL: never dropped by a job. Spec 11: financial records, transactions, journals and audit
  -- logs are retained for 7 years and never deleted by a job.
  retention_days integer,
  CONSTRAINT partition_policies_revoked_valid
    CHECK (revoked_privileges ~ '^(UPDATE|DELETE|TRUNCATE)(, (UPDATE|DELETE|TRUNCATE))*$'),
  CONSTRAINT partition_policies_retention_allowed
    CHECK (retention_days IS NULL OR parent IN
      ('api_request_logs', 'webhook_deliveries', 'notification_deliveries', 'gateway_events')),
  CONSTRAINT partition_policies_retention_floor
    CHECK (retention_days IS NULL OR retention_days >= 30)
);--> statement-breakpoint
INSERT INTO core.partition_policies (parent, revoked_privileges, retention_days) VALUES
  ('audit_logs',              'UPDATE, DELETE, TRUNCATE', NULL),
  ('journal_entries',         'UPDATE, DELETE, TRUNCATE', NULL),
  ('journal_lines',           'UPDATE, DELETE, TRUNCATE', NULL),
  ('transactions',            'DELETE, TRUNCATE',         NULL),
  ('webhook_deliveries',      'DELETE, TRUNCATE',         90),
  ('api_request_logs',        'UPDATE, DELETE, TRUNCATE', 90),
  ('notification_deliveries', 'DELETE, TRUNCATE',         180);--> statement-breakpoint
-- Policies change by migration only.
REVOKE UPDATE, DELETE, TRUNCATE ON core.partition_policies FROM mulapay_core_rw;--> statement-breakpoint
CREATE TRIGGER partition_policies_append_only BEFORE UPDATE OR DELETE ON core.partition_policies FOR EACH ROW EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint
CREATE TRIGGER partition_policies_no_truncate BEFORE TRUNCATE ON core.partition_policies FOR EACH STATEMENT EXECUTE FUNCTION core.reject_mutation();--> statement-breakpoint

-- The upper bound (exclusive) of a range partition, read from the catalogue. Bound literals
-- carry an offset, so the cast does not depend on the session time zone.
CREATE OR REPLACE FUNCTION core.partition_upper_bound(partition_oid oid) RETURNS timestamptz
  LANGUAGE sql STABLE
AS $$
  SELECT substring(pg_get_expr(c.relpartbound, c.oid) FROM $re$TO \('([^']+)'\)$re$)::timestamptz
    FROM pg_class c
   WHERE c.oid = partition_oid
$$;--> statement-breakpoint

-- Creates the current month and `p_months_ahead` more for every policy (spec 5.1: three months
-- ahead), with the revokes of the policy. Idempotent. A month is skipped, and reported as
-- `blocked_default_has_rows`, when the default partition already holds rows in its range:
-- creating it would fail, and the rows cannot be moved (they may be append-only).
-- Each month is attempted on its own, so one failure never stops the others.
CREATE OR REPLACE FUNCTION core.ensure_partitions(
  p_now timestamptz DEFAULT now(),
  p_months_ahead integer DEFAULT 3
) RETURNS TABLE (parent text, partition_name text, month_start date, outcome text)
  LANGUAGE plpgsql
AS $$
DECLARE
  policy record;
  first_month date := date_trunc('month', p_now AT TIME ZONE 'UTC')::date;
  month date;
  lo timestamptz;
  hi timestamptz;
  name text;
  blocked boolean;
BEGIN
  IF p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'p_months_ahead must be between 0 and 24, got %', p_months_ahead;
  END IF;
  FOR policy IN SELECT pp.parent, pp.revoked_privileges FROM core.partition_policies pp ORDER BY pp.parent LOOP
    FOR i IN 0..p_months_ahead LOOP
      month := (first_month + make_interval(months => i))::date;
      name := policy.parent || '_' || to_char(month, 'YYYYMM');
      lo := month::timestamp AT TIME ZONE 'UTC';
      hi := (month + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      parent := policy.parent;
      partition_name := name;
      month_start := month;
      IF to_regclass(format('core.%I', name)) IS NOT NULL THEN
        outcome := 'exists';
        RETURN NEXT;
        CONTINUE;
      END IF;
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM core.%I WHERE created_at >= %L AND created_at < %L)',
        policy.parent || '_default', lo, hi
      ) INTO blocked;
      IF blocked THEN
        outcome := 'blocked_default_has_rows';
        RETURN NEXT;
        CONTINUE;
      END IF;
      BEGIN
        PERFORM core.create_monthly_partitions(policy.parent, month, 1, false);
        EXECUTE format('REVOKE %s ON core.%I FROM mulapay_core_rw', policy.revoked_privileges, name);
        outcome := 'created';
      EXCEPTION WHEN OTHERS THEN
        outcome := 'failed: ' || SQLSTATE;
      END;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END
$$;--> statement-breakpoint

-- Health of every policy: how far ahead partitions exist and whether rows have fallen into the
-- default partition (which means partitions were missing when they were written).
CREATE OR REPLACE FUNCTION core.partition_status(p_now timestamptz DEFAULT now())
  RETURNS TABLE (parent text, partitions integer, months_ahead integer, default_has_rows boolean)
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  policy record;
  newest timestamptz;
  count_ integer;
  has_rows boolean;
BEGIN
  FOR policy IN SELECT pp.parent AS p FROM core.partition_policies pp ORDER BY pp.parent LOOP
    SELECT max(core.partition_upper_bound(c.oid)), count(*)::integer
      INTO newest, count_
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = format('core.%I', policy.p)::regclass
       AND c.relname <> policy.p || '_default';
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM core.%I)', policy.p || '_default') INTO has_rows;
    parent := policy.p;
    partitions := count_;
    -- Whole months covered after the current one: the newest upper bound is the first instant
    -- not covered, so the month before it is the last covered month.
    months_ahead := CASE WHEN newest IS NULL THEN -1 ELSE
      ((extract(year FROM newest AT TIME ZONE 'UTC')::integer - extract(year FROM p_now AT TIME ZONE 'UTC')::integer) * 12
       + extract(month FROM newest AT TIME ZONE 'UTC')::integer - extract(month FROM p_now AT TIME ZONE 'UTC')::integer - 1)
    END;
    default_has_rows := has_rows;
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint

-- Partitions whose every row is older than the policy's retention, with the reason one cannot be
-- dropped yet. Read-only.
CREATE OR REPLACE FUNCTION core.partitions_due_for_retention(p_now timestamptz DEFAULT now())
  RETURNS TABLE (parent text, partition_name text, upper_bound timestamptz, approx_rows bigint, blocked_reason text)
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  candidate record;
  pending boolean;
BEGIN
  FOR candidate IN
    SELECT pp.parent AS p, c.relname::text AS part, core.partition_upper_bound(c.oid) AS upper_at,
           GREATEST(c.reltuples, 0)::bigint AS approx
      FROM core.partition_policies pp
      JOIN pg_inherits i ON i.inhparent = format('core.%I', pp.parent)::regclass
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE pp.retention_days IS NOT NULL
       AND c.relname <> pp.parent || '_default'
       AND core.partition_upper_bound(c.oid) <= p_now - make_interval(days => pp.retention_days)
     ORDER BY pp.parent, c.relname
  LOOP
    parent := candidate.p;
    partition_name := candidate.part;
    upper_bound := candidate.upper_at;
    approx_rows := candidate.approx;
    blocked_reason := NULL;
    -- A delivery still waiting to be sent is live work, not history.
    IF candidate.p = 'webhook_deliveries' THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM core.%I WHERE status = ''pending'')', candidate.part) INTO pending;
      IF pending THEN blocked_reason := 'pending_deliveries'; END IF;
    END IF;
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint

-- Drops one expired partition. It re-validates everything, so a caller bug cannot drop anything
-- the policy does not allow: the parent must have a retention policy, the partition must belong
-- to it, must not be the default partition, must end before the retention cutoff, and must
-- carry no live work. The lock wait is bounded: a busy parent means "try again next run".
CREATE OR REPLACE FUNCTION core.drop_partition(
  p_parent text,
  p_partition text,
  p_now timestamptz DEFAULT now()
) RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  policy core.partition_policies;
  partition_oid oid;
  upper_at timestamptz;
  pending boolean;
BEGIN
  SELECT * INTO policy FROM core.partition_policies WHERE parent = p_parent;
  IF NOT FOUND OR policy.retention_days IS NULL THEN
    RAISE EXCEPTION 'core.% has no retention policy: its partitions are never dropped', p_parent
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_partition = p_parent || '_default' THEN
    RAISE EXCEPTION 'the default partition of core.% is never dropped', p_parent
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.oid INTO partition_oid
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = format('core.%I', p_parent)::regclass AND c.relname = p_partition;
  IF partition_oid IS NULL THEN
    RAISE EXCEPTION 'core.% is not a partition of core.%', p_partition, p_parent
      USING ERRCODE = 'undefined_table';
  END IF;
  upper_at := core.partition_upper_bound(partition_oid);
  IF upper_at IS NULL OR upper_at > p_now - make_interval(days => policy.retention_days) THEN
    RAISE EXCEPTION 'core.% still holds rows inside the % day retention window', p_partition, policy.retention_days
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_parent = 'webhook_deliveries' THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM core.%I WHERE status = ''pending'')', p_partition) INTO pending;
    IF pending THEN
      RAISE EXCEPTION 'core.% holds pending deliveries', p_partition USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM set_config('lock_timeout', '5000', true);
  EXECUTE format('DROP TABLE core.%I', p_partition);
END
$$;
--> statement-breakpoint
-- Bring a database that has been running for months up to date in the same deploy.
SELECT count(*) FROM core.ensure_partitions();
