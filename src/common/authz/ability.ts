/**
 * CASL abilities, one factory per actor type (spec section 8.4).
 *
 * Abilities answer "may this actor perform this action on this kind of resource". They do
 * not scope by merchant: merchant scoping is enforced by every repository method taking a
 * `merchantId` (spec 8.4), so a bug in a rule cannot widen data access across merchants.
 *
 * Invariant: an actor holds exactly the permissions its roles or scopes grant. Unknown
 * permissions are dropped rather than granted, and `manage` on a subject implies every
 * action on that subject (CASL semantics).
 */
import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';
import {
  API_KEY_SCOPES,
  MERCHANT_PERMISSIONS,
  STAFF_PERMISSIONS,
  parsePermission,
  type Permission,
} from './permissions';

export type AppAbility = MongoAbility<[string, string]>;

function build(granted: Iterable<string>, allowed: ReadonlySet<string>): AppAbility {
  const { can, build: finish } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const permission of granted) {
    if (!allowed.has(permission)) continue;
    const { subject, action } = parsePermission(permission);
    can(action, subject);
  }
  return finish();
}

const MERCHANT_SET: ReadonlySet<string> = new Set(MERCHANT_PERMISSIONS);
const STAFF_SET: ReadonlySet<string> = new Set(STAFF_PERMISSIONS);
const SCOPE_SET: ReadonlySet<string> = new Set(API_KEY_SCOPES);

/** Merchant user: the permissions of their team role. */
export function merchantUserAbility(rolePermissions: Iterable<string>): AppAbility {
  return build(rolePermissions, MERCHANT_SET);
}

/** Staff: the union of the permissions of all their staff roles. */
export function staffAbility(rolePermissions: Iterable<string>): AppAbility {
  return build(rolePermissions, STAFF_SET);
}

/** API key: its scopes. */
export function apiKeyAbility(scopes: Iterable<string>): AppAbility {
  return build(scopes, SCOPE_SET);
}

export function abilityAllows(ability: AppAbility, permission: Permission): boolean {
  const { subject, action } = parsePermission(permission);
  return ability.can(action, subject);
}
