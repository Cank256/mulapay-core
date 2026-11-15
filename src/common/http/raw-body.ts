/**
 * Keeps the raw bytes of a JSON request body next to the parsed value.
 *
 * Request signing (spec 6.11) hashes the body exactly as the client sent it; hashing a
 * re-serialised object would make the signature depend on key order and whitespace. The
 * parser below delegates to Fastify's own JSON parser, so prototype-poisoning protection
 * and the empty-body error are unchanged, and only adds `request.rawBody`.
 */
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact request body bytes. Absent when the request had no JSON body. */
    rawBody?: Buffer;
  }
}

export function registerRawBodyCapture(fastify: FastifyInstance): void {
  const parseJson = fastify.getDefaultJsonParser('error', 'error');
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    request.rawBody = raw;
    void parseJson(request, raw.toString('utf8'), done);
  });
}
