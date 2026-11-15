/**
 * Turns every exception on the HTTP path into the error envelope.
 *
 * Server errors are logged with full (redacted) detail and returned with the generic
 * catalogue message plus the requestId, as the gateway does. Client errors are logged at
 * warn without stack traces.
 */
import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { toLoggableError } from '../logging/redaction';
import { AppError } from './app-error';
import { ROOT_LOGGER } from '../tokens';
import { errorDocUrl } from './catalogue';
import type { ErrorEnvelope } from './envelope';
import { resolveError } from './error-mapper';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const resolved = resolveError(exception);
    request.errorCode = resolved.code;

    const logFields = {
      errorCode: resolved.code,
      statusCode: resolved.httpStatus,
      method: request.method,
      route: request.routeOptions?.url,
    };
    if (resolved.isServerError) {
      this.logger.error({ ...logFields, err: toLoggableError(exception) }, 'request failed');
    } else {
      this.logger.warn(logFields, 'request rejected');
    }

    if (reply.sent) return;

    if (exception instanceof AppError && exception.retryAfterSeconds !== undefined) {
      void reply.header('Retry-After', String(Math.max(1, Math.ceil(exception.retryAfterSeconds))));
    }

    const body: ErrorEnvelope = {
      success: false,
      error: {
        code: resolved.code,
        message: resolved.message,
        ...(resolved.details ? { details: { ...resolved.details } } : {}),
        requestId: request.id,
        docUrl: errorDocUrl(resolved.code),
      },
    };
    void reply.status(resolved.httpStatus).type('application/json; charset=utf-8').send(body);
  }
}
