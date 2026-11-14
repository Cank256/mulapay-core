/**
 * Converts Zod schemas to JSON Schema once, at module load (spec section 9.2 rule 2):
 * draft-07 for Fastify's fast-json-stringify serializer, OpenAPI 3.0 for the docs.
 *
 * Fast-json-stringify writes only the properties the schema declares, so a response schema
 * is also the allowlist that keeps internal fields out of responses (spec section 11).
 */
import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export function toFastifySchema(schema: z.ZodType): JsonSchema {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'output',
    unrepresentable: 'throw',
  });
  return rest;
}

export function toOpenApiSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'output', unrepresentable: 'throw' });
}
