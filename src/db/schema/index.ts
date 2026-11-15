/**
 * Drizzle schema root. All core tables live in the `core` Postgres schema (decision D1);
 * one file per domain is re-exported from here as each phase adds tables.
 */
export { core } from './core';
export * from './identity';
export * from './authz';
export * from './merchants';
export * from './api-keys';
export * from './audit';
export * from './ledger';
export * from './transactions';
export * from './payments';
export * from './idempotency';
export * from './holds';
export * from './developer';
