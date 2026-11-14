/**
 * Response schema decorators. Every route declares its response schemas (spec section 9.2
 * rule 1): one declaration feeds the Fastify serializer and the OpenAPI document.
 *
 *   @ApiEnvelopedResponses({ 200: paymentSchema })  -> wrapped in { success, data, meta }
 *   @ApiRawResponses({ 200: livenessSchema })       -> sent as-is (health, metrics)
 */
import { applyDecorators, SetMetadata } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import { ApiResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { successEnvelopeSchema } from '../errors/envelope';
import { toFastifySchema, toOpenApiSchema } from './json-schema';

export const RAW_RESPONSE = Symbol('RAW_RESPONSE');

/** Skips the success envelope for this handler. */
export const RawResponse = () => SetMetadata(RAW_RESPONSE, true);

type ResponseMap = Readonly<Record<number, z.ZodType>>;

function responseDecorators(responses: ResponseMap, wrap: (s: z.ZodType) => z.ZodType) {
  const fastifyResponses: Record<number, unknown> = {};
  const docs: MethodDecorator[] = [];
  for (const [status, schema] of Object.entries(responses)) {
    const wrapped = wrap(schema);
    fastifyResponses[Number(status)] = toFastifySchema(wrapped);
    docs.push(
      ApiResponse({
        status: Number(status),
        schema: toOpenApiSchema(wrapped),
      })
    );
  }
  return [RouteSchema({ response: fastifyResponses }), ...docs];
}

export function ApiEnvelopedResponses(responses: ResponseMap) {
  return applyDecorators(...responseDecorators(responses, (s) => successEnvelopeSchema(s)));
}

export function ApiRawResponses(responses: ResponseMap) {
  return applyDecorators(RawResponse(), ...responseDecorators(responses, (s) => s));
}
