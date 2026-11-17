/**
 * Gateway event source abstraction (spec 3.6, Phase 3). Two implementations: database (reads
 * `public.operation_events` in the gateway's database through the `ro` pool) and HTTP (calls
 * `GET /api/v1/events` on the gateway). Selected by `GATEWAY_EVENT_SOURCE` config.
 *
 * The consumer reads events starting after the last cursor position, applies them idempotently,
 * and advances the cursor. Both sources enforce the mandatory 2-second lag (spec 3.6) so a
 * committed event's id is visible before core sees it.
 */

export const GATEWAY_EVENT_SOURCE = Symbol('GATEWAY_EVENT_SOURCE');

export type GatewayOperationType = 'collection' | 'disbursement' | 'refund';

export interface GatewayEvent {
  readonly id: bigint;
  readonly eventId: string;
  readonly operationId: string | null;
  readonly tenantId: string;
  readonly providerId: string;
  readonly operationType: GatewayOperationType;
  readonly externalId: string;
  readonly referenceId: string | null;
  readonly providerTransactionId: string | null;
  readonly status: string;
  readonly previousStatus: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly reason: string | null;
  readonly source: string;
  readonly occurredAt: Date;
}

export interface GatewayEventSource {
  /**
   * Fetches events starting after `afterId`, up to `limit`, with the mandatory 2-second lag.
   * Returns events in ascending id order. Throws on transport or database errors (the consumer
   * will retry).
   */
  fetchEvents(afterId: bigint, limit: number): Promise<readonly GatewayEvent[]>;
}
