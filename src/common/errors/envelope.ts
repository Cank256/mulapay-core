/**
 * Response envelope (spec section 8.1), shared with the gateway's shape:
 *
 *   success: { success: true, data, meta: { requestId } }
 *   failure: { success: false, error: { code, message, details?, requestId, docUrl } }
 */
import { z } from 'zod';

export const responseMetaSchema = z.object({
  requestId: z.string(),
});

export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({
    success: z.literal(true),
    data,
    meta: responseMetaSchema,
  });
}

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
    docUrl: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export interface SuccessEnvelope<T> {
  readonly success: true;
  readonly data: T;
  readonly meta: { readonly requestId: string };
}
