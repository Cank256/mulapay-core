/**
 * Policy decorators (spec section 8.4). Every route carries exactly one of:
 *
 *   @Public()                       no authentication (login, health)
 *   @Authenticated()                any authenticated actor of the route's surface
 *   @RequirePermission('team:manage')  authenticated and the ability allows it
 *
 * A route with none of them is refused by the guard (fail closed), and a test asserts
 * that no registered route is undecorated.
 *
 * `@RequiresStepUp()` adds the step-up check (spec 8.3) on top of the policy.
 */
import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type { Permission } from './permissions';

export const POLICY = Symbol('POLICY');
export const STEP_UP = Symbol('STEP_UP');

export type Policy =
  | { readonly kind: 'public' }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'permission'; readonly permission: Permission };

export const Public = () => SetMetadata(POLICY, { kind: 'public' } satisfies Policy);

export const Authenticated = () => SetMetadata(POLICY, { kind: 'authenticated' } satisfies Policy);

/** Also documents the permission (a scope, on `/v1`) as `x-required-permission` for OpenAPI. */
export const RequirePermission = (permission: Permission) =>
  applyDecorators(
    SetMetadata(POLICY, { kind: 'permission', permission } satisfies Policy),
    ApiExtension('x-required-permission', permission)
  );

export const RequiresStepUp = () => SetMetadata(STEP_UP, true);
