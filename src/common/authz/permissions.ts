/**
 * Permission, role and scope catalogues (spec section 8.4).
 *
 * Permissions are `{subject}:{action}` strings. The database holds which role has which
 * permission (seeded by migration 0001, editable by admins); this file holds the set of
 * permissions that exist, so code can only check permissions the database can grant. An
 * integration test asserts the two agree.
 */

export const MERCHANT_PERMISSIONS = [
  'merchant:read',
  'merchant:update',
  'team:read',
  'team:manage',
  'api_keys:read',
  'api_keys:manage',
  'payments:read',
  'transactions:read',
  'webhooks:read',
  'webhooks:manage',
  'request_logs:read',
] as const;

export const STAFF_PERMISSIONS = [
  'merchants:read',
  'merchants:create',
  'merchants:update',
  'merchants:lifecycle',
  'audit_logs:read',
  'audit_logs:verify',
  'roles:read',
  'roles:manage',
  'ledger:read',
  'balances:read',
  'holds:read',
] as const;

export type MerchantPermission = (typeof MERCHANT_PERMISSIONS)[number];
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

/** Team roles for merchant users (spec 6.10). Fixed: admins edit permissions, not the set. */
export const MERCHANT_ROLES = [
  'owner',
  'admin',
  'developer',
  'finance',
  'support',
  'viewer',
] as const;
export type MerchantRole = (typeof MERCHANT_ROLES)[number];

/** Staff roles. The spec does not name them; see docs/SECURITY.md. */
export const STAFF_ROLES = [
  'super_admin',
  'operations',
  'compliance',
  'support_agent',
  'auditor',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * API key scopes gate public route groups (spec 6.11). Phase 1 issues and stores them; the
 * payment, payment link, checkout session and transaction routes use `payments:*` and
 * `transactions:read`. The scopes of the other route groups arrive with their phases.
 */
export const API_KEY_SCOPES = [
  'payments:read',
  'payments:write',
  'payouts:read',
  'payouts:write',
  'refunds:read',
  'refunds:write',
  'transactions:read',
  'balances:read',
  'customers:read',
  'customers:write',
  'settlements:read',
  'events:read',
  'webhooks:read',
  'webhooks:write',
  'disputes:read',
  'disputes:write',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type Permission = MerchantPermission | StaffPermission | ApiKeyScope;

/** Splits `subject:action`. Throws on a malformed key, which is a programming error. */
export function parsePermission(permission: string): { subject: string; action: string } {
  const [subject, action, ...rest] = permission.split(':');
  if (!subject || !action || rest.length > 0) {
    throw new Error(`malformed permission "${permission}"`);
  }
  return { subject, action };
}
