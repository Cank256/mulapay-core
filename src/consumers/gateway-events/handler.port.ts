/**
 * Gateway event handler interface (Phase 3). Each `(operation_type, status)` combination has
 * its own handler. Collection handlers (6) apply payment lifecycle transitions. Disbursement
 * and refund handlers (12) are stubs until P4-11 and P4-12.
 *
 * Handlers are called inside the consumer's transaction (spec 10.2): insert, handler, cursor
 * update as one atomic unit. A handler that throws after 3 attempts causes the event to be
 * marked `failed`, the cursor advanced, and an exception raised.
 */
import type { Transaction } from '../../common/db/database.types';
import type { GatewayEvent } from '../../integrations/gateway/gateway-event-source.port';

export interface EventHandler {
  /**
   * Applies the event to core state. Called inside the consumer's transaction. Must be
   * idempotent: repeated calls with the same event (dedupe failure, retry) must not create
   * duplicate effects.
   *
   * Returns true if the event was applied, false if it was skipped (e.g., event for unknown
   * transaction, event trying to move a terminal transaction).
   */
  handle(tx: Transaction, event: GatewayEvent): Promise<boolean>;
}

export type OperationTypeStatus = `${string}:${string}`;

export interface EventHandlerRegistry {
  getHandler(operationType: string, status: string): EventHandler | undefined;
}
