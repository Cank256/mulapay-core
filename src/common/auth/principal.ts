/**
 * The authenticated actor of a request, set by the AuthGuard. Controllers read it with
 * `@CurrentPrincipal()`; application services receive the fields they need explicitly.
 *
 * Internal UUIDs (`userId`, `merchant.id`) are for repository calls only; responses and
 * audit rows use the public refs.
 */
import type { AppAbility } from '../authz/ability';
import type { MerchantRole } from '../authz/permissions';
import type { AccessTokenClaims, AccessTokenSubject, AuthMethod } from './access-token.service';

export type MerchantStatus = 'draft' | 'pending_kyc' | 'active' | 'suspended' | 'closed';
export type Environment = 'test' | 'live';

export interface PrincipalMerchant {
  readonly id: string;
  readonly ref: string;
  readonly status: MerchantStatus;
}

interface UserPrincipalBase {
  readonly userId: string;
  readonly userRef: string;
  readonly name: string;
  readonly email: string;
  /** Public session id (`ses_...`), the JWT `sid`. */
  readonly sessionId: string;
  readonly mfa: boolean;
  readonly amr: readonly AuthMethod[];
  readonly authTime: Date;
  readonly ability: AppAbility;
}

export interface MerchantUserPrincipal extends UserPrincipalBase {
  readonly kind: 'merchant_user';
  readonly merchant: PrincipalMerchant;
  readonly role: MerchantRole;
}

export interface StaffPrincipal extends UserPrincipalBase {
  readonly kind: 'staff';
  readonly roles: readonly string[];
}

export interface ApiKeyPrincipal {
  readonly kind: 'api_key';
  readonly apiKeyId: string;
  readonly apiKeyRef: string;
  readonly name: string;
  readonly merchant: PrincipalMerchant;
  readonly environment: Environment;
  readonly scopes: readonly string[];
  readonly ability: AppAbility;
}

export type UserPrincipal = MerchantUserPrincipal | StaffPrincipal;
export type Principal = UserPrincipal | ApiKeyPrincipal;

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Resolves verified token claims to a live principal; null if the user or session is gone. */
export interface PrincipalResolver {
  resolve(claims: AccessTokenClaims): Promise<UserPrincipal | null>;
}

/** Authenticates a raw `mp_...` key; null if it is unknown, revoked, expired or not allowed. */
export interface ApiKeyAuthenticator {
  authenticate(rawKey: string, clientIp: string): Promise<ApiKeyPrincipal | null>;
}

export const PRINCIPAL_RESOLVER = Symbol('PRINCIPAL_RESOLVER');
export const API_KEY_AUTHENTICATOR = Symbol('API_KEY_AUTHENTICATOR');

export type { AccessTokenSubject };
