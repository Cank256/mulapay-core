/**
 * Drizzle schema root. All core tables live in the `core` Postgres schema (decision D1);
 * one file per domain is re-exported from here as each phase adds tables.
 *
 * Phase 0 defines no tables. The `core` schema itself is created by the bootstrap SQL in
 * src/db/bootstrap, not by a migration, because mulapay_core_rw has no CREATE privilege on
 * the database (see docs/DATABASE.md).
 */
import { pgSchema } from 'drizzle-orm/pg-core';

export const core = pgSchema('core');
