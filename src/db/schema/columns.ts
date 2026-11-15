/** Column helpers shared by the schema files (spec section 5 conventions). */
import { customType, timestamp } from 'drizzle-orm/pg-core';

/** `core.citext`, installed by the bootstrap SQL. Case-insensitive text for emails. */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'core.citext';
  },
});

/** `created_at timestamptz not null default now()` */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/** `updated_at timestamptz`, maintained by the core.set_updated_at() trigger. */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
