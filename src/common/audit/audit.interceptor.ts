/**
 * Audit interceptor (spec section 6.14): every state-changing request leaves an audit row,
 * including denied and failed ones.
 *
 * - Success: the application service has already written the row (with before and after)
 *   in the business transaction. If it did not, a backstop row is written here so the
 *   request is never unaudited.
 * - Failure of an authenticated request: a row with outcome `denied` (401/403) or `error`.
 *   Unauthenticated failures are counted in metrics instead, so anonymous traffic cannot
 *   make the platform write audit rows.
 *
 * Denials raised by the guard happen before interceptors run; the guard records those.
 */
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { requestContext } from '../context/request-context';
import { resolveError } from '../errors/error-mapper';
import { toLoggableError } from '../logging/redaction';
import { ROOT_LOGGER } from '../tokens';
import { AUDITED, type AuditedMetadata } from './audited.decorator';
import { AuditService, type AuditOutcome } from './audit.service';

/** The public id in the route params, if any (`:ref`, `:id`, `:userId`, `:key`). */
export function routeResourceId(request: FastifyRequest): string | null {
  const params = (request.params ?? {}) as Record<string, unknown>;
  for (const name of ['ref', 'id', 'userId', 'key', 'merchantRef']) {
    const value = params[name];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 128);
  }
  return null;
}

export function failureOutcome(error: unknown): AuditOutcome {
  const status = resolveError(error).httpStatus;
  return status === 401 || status === 403 ? 'denied' : 'error';
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditedMetadata | undefined>(AUDITED, context.getHandler());
    if (context.getType() !== 'http' || !meta) return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const ctx = requestContext.get();
    const rowsBefore = ctx?.auditRows ?? 0;

    return next.handle().pipe(
      mergeMap((result: unknown) =>
        from(this.afterSuccess(meta, request, rowsBefore)).pipe(mergeMap(() => [result]))
      ),
      catchError((error: unknown) =>
        from(this.afterFailure(meta, request, error)).pipe(mergeMap(() => throwError(() => error)))
      )
    );
  }

  private async afterSuccess(meta: AuditedMetadata, request: FastifyRequest, rowsBefore: number) {
    const store = requestContext.get();
    if ((store?.auditRows ?? 0) > rowsBefore || store?.auditNotApplicable) return;
    await this.write(meta, request, 'success');
  }

  private async afterFailure(meta: AuditedMetadata, request: FastifyRequest, error: unknown) {
    if (!requestContext.get()?.actorType) return;
    await this.write(meta, request, failureOutcome(error));
  }

  private async write(meta: AuditedMetadata, request: FastifyRequest, outcome: AuditOutcome) {
    try {
      await this.audit.recordStandalone({
        action: meta.action,
        resourceType: meta.resourceType,
        resourceId: routeResourceId(request),
        outcome,
      });
    } catch (error) {
      // The request's own outcome stands; a missing audit row is an alert, not a 500.
      this.logger.error(
        { err: toLoggableError(error), action: meta.action, outcome },
        'audit row could not be written'
      );
    }
  }
}
