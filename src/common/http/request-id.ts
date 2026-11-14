/**
 * Request ids (spec section 8.1): `X-Request-Id` is accepted from the edge and echoed on
 * every response. Incoming values are accepted only if they are short and made of safe
 * characters, so a client cannot inject log content; otherwise a new id is generated.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function isAcceptableRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function generateRequestId(req: Pick<IncomingMessage, 'headers'>): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  return isAcceptableRequestId(incoming) ? incoming : randomUUID();
}
