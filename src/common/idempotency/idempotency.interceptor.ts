/**
 * Reads and validates `Idempotency-Key`, fingerprints the request (spec 8.2 step 2) and
 * unwraps the `IdempotentResponse` the handler returns.
 *
 * Runs after the guard, so an unauthenticated request is answered 401 before any header
 * check, and before the validation pipe, so the fingerprint covers the body as the client
 * sent it, not as a schema transformed it.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';
import { sha256Hex } from '../crypto/crypto';
import { AppError } from '../errors/app-error';
import { canonicalJson } from './canonical-json';
import { IDEMPOTENT_OPERATION, IdempotentResponse } from './idempotency.types';

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** `sha256(canonicalJson(body) + method + path)` (spec 8.2), path without the query. */
export function requestFingerprint(method: string, url: string, body: unknown): string {
  const path = url.split('?')[0] ?? url;
  return sha256Hex(canonicalJson(body ?? null) + method.toUpperCase() + path);
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const operation = this.reflector.get<string | undefined>(
      IDEMPOTENT_OPERATION,
      context.getHandler()
    );
    if (!operation) return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const header = request.headers['idempotency-key'];
    if (typeof header !== 'string' || !KEY_PATTERN.test(header)) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
    }
    request.idempotency = {
      operation,
      key: header,
      fingerprint: requestFingerprint(request.method, request.url, request.body),
    };
    return next.handle().pipe(
      map((result: unknown): unknown => {
        if (!(result instanceof IdempotentResponse)) return result;
        if (result.replayed) void reply.header('Idempotency-Replayed', 'true');
        return result.body as unknown;
      })
    );
  }
}
