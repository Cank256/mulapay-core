/**
 * Disbursement event handlers (6 combinations): apply payout lifecycle transitions. Settlement
 * payouts (external_id starts with `po_`) call `SettlementOutcomeService.apply` (Phase 6).
 * Merchant payouts are completed in P4-11.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ROOT_LOGGER } from '../../../common/tokens';
import type { Transaction } from '../../../common/db/database.types';
import type { GatewayEvent } from '../../../integrations/gateway/gateway-event-source.port';
import type { EventHandler } from '../handler.port';

@Injectable()
export class DisbursementPendingHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-11: verify payout exists and is in processing state
    // For settlement payouts (po_*), this is a no-op
    this.logger.debug({ externalId: _event.externalId }, 'disbursement pending');
    return true;
  }
}

@Injectable()
export class DisbursementUnknownHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-11: mark payout outcome_unknown, do not release hold
    this.logger.debug({ externalId: _event.externalId }, 'disbursement unknown');
    return true;
  }
}

@Injectable()
export class DisbursementSuccessfulHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // Check if this is a settlement payout
    if (_event.externalId.startsWith('po_')) {
      // TODO P6-01: call SettlementOutcomeService.apply(tx, { payoutRef, eventKey, signal: 'successful' })
      this.logger.debug({ externalId: _event.externalId }, 'settlement payout succeeded');
      return true;
    }

    // TODO P4-11: capture hold, post disbursement entry, transition to succeeded
    this.logger.debug({ externalId: _event.externalId }, 'merchant disbursement succeeded');
    return true;
  }
}

@Injectable()
export class DisbursementFailedHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // Check if this is a settlement payout
    if (_event.externalId.startsWith('po_')) {
      // TODO P6-01: call SettlementOutcomeService.apply(tx, { payoutRef, eventKey, signal: 'failed' })
      this.logger.debug({ externalId: _event.externalId }, 'settlement payout failed');
      return true;
    }

    // TODO P4-11: release hold, transition to failed
    this.logger.debug({ externalId: _event.externalId }, 'merchant disbursement failed');
    return true;
  }
}

@Injectable()
export class DisbursementExpiredHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-11: release hold, transition to expired
    this.logger.debug({ externalId: _event.externalId }, 'disbursement expired');
    return true;
  }
}

@Injectable()
export class DisbursementCancelledHandler implements EventHandler {
  constructor(@Inject(ROOT_LOGGER) private readonly logger: Logger) {}

  async handle(_tx: Transaction, _event: GatewayEvent): Promise<boolean> {
    // TODO P4-11: release hold, transition to cancelled
    this.logger.debug({ externalId: _event.externalId }, 'disbursement cancelled');
    return true;
  }
}
