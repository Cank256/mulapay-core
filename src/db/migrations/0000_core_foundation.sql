-- Phase 0 foundation.
--
-- drizzle-kit generated `CREATE SCHEMA "core"` here. The schema is created by
-- src/db/bootstrap/001_core_roles_and_schema.sql instead, because mulapay_core_rw has no
-- CREATE privilege on the database. The snapshot still records the schema, so later
-- `db:generate` runs will not emit CREATE SCHEMA again.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') THEN
    RAISE EXCEPTION 'schema "core" must be created by the bootstrap SQL (docs/DATABASE.md)';
  END IF;
END
$$;
--> statement-breakpoint
-- Spec section 5: `updated_at` is maintained by a trigger. Tables attach it with
--   CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON core.<table>
--     FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();
CREATE OR REPLACE FUNCTION core.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
