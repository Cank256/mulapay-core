/**
 * Per-route documentation that the OpenAPI enrichment (`public-api-document.ts`) turns into
 * the full operation: error responses, webhook behaviour and examples. The decorators only
 * attach `x-` extensions; the document builder reads and removes them.
 *
 *   @ApiErrors('PAYMENT_REQUEST_INVALID')   route-specific catalogue codes
 *   @ApiEmits('payment.created')            merchant events (and so webhooks) the call causes
 *   @ApiExample({ request, response })      hand-written examples; otherwise generated
 */
import { applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type { ErrorCode } from '../errors/catalogue';
import type { MerchantEventType } from '../../modules/events/domain/event-types';

export const ApiErrors = (...codes: ErrorCode[]) => ApiExtension('x-error-codes', codes);

export const ApiEmits = (...events: MerchantEventType[]) =>
  applyDecorators(ApiExtension('x-webhook-events', events));

export interface RouteExamples {
  /** Example request body. */
  readonly request?: unknown;
  /** Example of the `data` member of the success response. */
  readonly response?: unknown;
}

export const ApiExample = (examples: RouteExamples) => ApiExtension('x-examples', examples);
