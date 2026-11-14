/**
 * Fastify lifecycle hooks shared by every route:
 *
 * - opens the request context (requestId, surface) for log correlation
 * - echoes `X-Request-Id` on every response, including errors
 * - records `core_http_request_duration_seconds` with the route template, never the raw URL
 * - writes one completion log line per request (bodies are never logged)
 */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { requestContext } from '../context/request-context';
import { redactUrl } from '../logging/redaction';
import { httpRequestDuration } from '../telemetry/metrics';
import { REQUEST_ID_HEADER } from './request-id';
import { resolveSurface } from './surface';

const UNMATCHED_ROUTE = 'unmatched';

export function registerRequestHooks(fastify: FastifyInstance, logger: Logger): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    requestContext.run({ requestId: request.id, surface: resolveSurface(request.url) }, done);
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const surface = resolveSurface(request.url);
    const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
    const statusCode = reply.statusCode;
    httpRequestDuration.observe(
      { surface, method: request.method, route, status_code: String(statusCode) },
      reply.elapsedTime / 1000
    );
    const level = surface === 'infra' && statusCode < 400 ? 'debug' : 'info';
    logger[level](
      {
        requestId: request.id,
        surface,
        method: request.method,
        route,
        url: redactUrl(request.url.split('?')[0]),
        statusCode,
        durationMs: Math.round(reply.elapsedTime),
        remoteAddress: request.ip,
      },
      'request completed'
    );
    done();
  });
}
