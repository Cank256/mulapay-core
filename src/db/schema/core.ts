/**
 * The `core` Postgres schema (decision D1). Created by the bootstrap SQL in
 * src/db/bootstrap, not by a migration, because mulapay_core_rw has no CREATE privilege on
 * the database (see docs/DATABASE.md).
 */
import { pgSchema } from 'drizzle-orm/pg-core';

export const core = pgSchema('core');
