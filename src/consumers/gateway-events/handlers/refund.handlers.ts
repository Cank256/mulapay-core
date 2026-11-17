/**
 * Refund event handlers (6 combinations): apply refund lifecycle transitions. Completed in
 * P4-12 alongside the refund flow.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../../common/tokens';
import type { Transaction } from '../../../common/db/database.types';
import type { GatewayEvent } from '../../../integrations/gateway/gateway-event-source.port';
import type { EventHandler } from '../handler.port';

@Injectable()
export class RefundPendingHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-12: verify refund exists and is in processing state
    this.logger.debug({ externalId: _event.externalId }, 'refund pending');
    return true;
  }
}

@Injectable()
export class RefundUnknownHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-12: mark refund outcome_unknown
    this.logger.debug({ externalId: _event.externalId }, 'refund unknown');
    return true;
  }
}

@Injectable()
export class RefundSuccessfulHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-12: capture hold, post refund entry, transition to succeeded
    this.logger.debug({ externalId: _event.externalId }, 'refund succeeded');
    return true;
  }
}

@Injectable()
export class RefundFailedHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-12: release hold, transition to failed
    this.logger.debug({ externalId: _event.externalId }, 'refund failed');
    return true;
  }
}

@Injectable()
export class RefundExpiredHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-12: release hold, transition to expired
    this.logger.debug({ externalId: _event.externalId }, 'refund expired');
    return true;
  }
}

@Injectable()
export class RefundCancelledHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-12: release hold, transition to cancelled
    this.logger.debug({ externalId: _event.externalId }, 'refund cancelled');
    return true;
  }
}
