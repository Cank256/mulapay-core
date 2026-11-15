/**
 * The merchant and environment a request acts on (spec 8.4, section 5).
 *
 * Every repository method on a merchant-scoped table takes a scope and filters on both
 * fields, and the scope is built from the authenticated principal, never from the request
 * body or query (so a caller cannot name another merchant). A test key is bound to the
 * `test` environment and a live key to `live`; a dashboard user chooses the environment per
 * request because their session is bound to the merchant only.
 */
import type {
  ApiKeyPrincipal,
  Environment,
  MerchantStatus,
  MerchantUserPrincipal,
} from './principal';

export interface MerchantScope {
  /** Internal merchant UUID, for repository calls only. */
  readonly merchantId: string;
  /** Public merchant ref (`mch_...`), safe to return and log. */
  readonly merchantRef: string;
  readonly merchantStatus: MerchantStatus;
  readonly environment: Environment;
}

export function scopeOfApiKey(principal: ApiKeyPrincipal): MerchantScope {
  return {
    merchantId: principal.merchant.id,
    merchantRef: principal.merchant.ref,
    merchantStatus: principal.merchant.status,
    environment: principal.environment,
  };
}

export function scopeOfMerchantUser(
  principal: MerchantUserPrincipal,
  environment: Environment
): MerchantScope {
  return {
    merchantId: principal.merchant.id,
    merchantRef: principal.merchant.ref,
    merchantStatus: principal.merchant.status,
    environment,
  };
}
