/**
 * drizzle-kit configuration, restricted to the `core` schema (decision D1).
 *
 * Use `npm run db:generate` to create migrations and `npm run db:migrate` to apply them.
 * Do not use `drizzle-kit migrate` or `drizzle-kit push`: both try to CREATE SCHEMA, which
 * mulapay_core_rw is not permitted to do (docs/DATABASE.md).
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  schemaFilter: ['core'],
  migrations: { schema: 'core', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.DATABASE_DIRECT_URL ?? '' },
  strict: true,
  verbose: true,
});
