export const DB_POOLS = Symbol('DB_POOLS');
/** Drizzle over the rw pool. The only handle allowed to write. */
export const DB_RW = Symbol('DB_RW');
/** Drizzle over the ro pool, for reading gateway-owned tables. */
export const DB_RO = Symbol('DB_RO');
/** Drizzle over the replica pool, for reports, analytics and admin lists. */
export const DB_REPLICA = Symbol('DB_REPLICA');
