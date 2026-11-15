/**
 * `@Idempotent('payments.create')` marks a route that requires an `Idempotency-Key` header
 * (spec 8.2) and attaches the interceptor that reads it. The route's handler passes
 * `@IdempotencyKey()` to an application service, which runs its work through
 * `IdempotencyService.run` and returns the `IdempotentResponse` unchanged.
 */
import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  UseInterceptors,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IDEMPOTENT_OPERATION, type IdempotencyContext } from './idempotency.types';

export const Idempotent = (operation: string) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_OPERATION, operation),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        '1 to 255 printable ASCII characters. Repeating a request with the same key and body ' +
        'returns the first response with `Idempotency-Replayed: true`; the same key with a ' +
        'different body is a 409.',
    })
  );

/** The idempotency context the interceptor built for this request. */
export const IdempotencyKey = createParamDecorator(
  (_: unknown, context: ExecutionContext): IdempotencyContext => {
    const ctx = context.switchToHttp().getRequest<FastifyRequest>().idempotency;
    if (!ctx)
      throw new AppError('INTERNAL_ERROR', { cause: new Error('route is not @Idempotent') });
    return ctx;
  }
);
