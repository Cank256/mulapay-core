/**
 * Parameter decorators for the authenticated actor. Each asserts the principal kind the
 * surface guarantees, so a controller cannot mistake a staff member for a merchant user.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import type {
  ApiKeyPrincipal,
  MerchantUserPrincipal,
  Principal,
  StaffPrincipal,
} from './principal';

function principalOf<K extends Principal['kind']>(context: ExecutionContext, kind: K) {
  const principal = context.switchToHttp().getRequest<FastifyRequest>().principal;
  if (principal?.kind !== kind) throw new AppError('UNAUTHORIZED');
  return principal as Extract<Principal, { kind: K }>;
}

export const CurrentMerchantUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): MerchantUserPrincipal =>
    principalOf(context, 'merchant_user')
);

export const CurrentStaff = createParamDecorator(
  (_: unknown, context: ExecutionContext): StaffPrincipal => principalOf(context, 'staff')
);

export const CurrentApiKey = createParamDecorator(
  (_: unknown, context: ExecutionContext): ApiKeyPrincipal => principalOf(context, 'api_key')
);
