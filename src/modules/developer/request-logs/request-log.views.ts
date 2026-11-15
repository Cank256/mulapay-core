/** Merchant-facing API request log entry. There is no body field: bodies are never stored. */
import { z } from 'zod';
import type { RequestLogRow } from './request-log.repository';

export const requestLogSchema = z.object({
  id: z.string(),
  environment: z.enum(['test', 'live']),
  apiKeyId: z.string(),
  method: z.string(),
  path: z.string(),
  route: z.string(),
  statusCode: z.number().int(),
  latencyMs: z.number().int(),
  requestId: z.string(),
  idempotencyKey: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type RequestLogView = z.infer<typeof requestLogSchema>;

export const requestLogPageSchema = z.object({
  items: z.array(requestLogSchema),
  nextCursor: z.string().nullable(),
});

export function toRequestLogView({ log, apiKeyRef }: RequestLogRow): RequestLogView {
  return {
    id: log.ref,
    environment: log.environment as RequestLogView['environment'],
    apiKeyId: apiKeyRef,
    method: log.method,
    path: log.path,
    route: log.route,
    statusCode: log.statusCode,
    latencyMs: log.latencyMs,
    requestId: log.requestId,
    idempotencyKey: log.idempotencyKey,
    ip: log.ip,
    userAgent: log.userAgent,
    errorCode: log.errorCode,
    createdAt: log.createdAt.toISOString(),
  };
}
