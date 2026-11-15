/**
 * The response hook that feeds request logging. Registered in the HTTP bootstrap, before the
 * server starts, so it runs for every route. It only acts on requests that authenticated
 * with an API key (the merchant is known), and only reads fields that were never secret:
 * it has no access to the body.
 */
import type { FastifyInstance } from 'fastify';
import type { RequestLogService } from './request-log.service';

declare module 'fastify' {
  interface FastifyRequest {
    /** Catalogue error code of the response, set by the exception filter. */
    errorCode?: string;
  }
}

export function registerRequestLogHook(fastify: FastifyInstance, logs: RequestLogService): void {
  fastify.addHook('onResponse', (request, reply, done) => {
    const principal = request.principal;
    if (principal?.kind === 'api_key') {
      const idempotencyKey = request.headers['idempotency-key'];
      const userAgent = request.headers['user-agent'];
      logs.record({
        merchantId: principal.merchant.id,
        environment: principal.environment,
        apiKeyId: principal.apiKeyId,
        method: request.method,
        url: request.url,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        requestId: request.id,
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
        ip: request.ip,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
        errorCode: request.errorCode,
      });
    }
    done();
  });
}
