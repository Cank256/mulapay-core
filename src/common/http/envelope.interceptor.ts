/** Wraps handler results in the success envelope unless the route opts out. */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';
import type { SuccessEnvelope } from '../errors/envelope';
import { RAW_RESPONSE } from './response-schema.decorator';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const raw = this.reflector.getAllAndOverride<boolean | undefined>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    return next.handle().pipe(
      map((data: unknown): SuccessEnvelope<unknown> => ({
        success: true,
        data: data ?? null,
        meta: { requestId: request.id },
      }))
    );
  }
}
