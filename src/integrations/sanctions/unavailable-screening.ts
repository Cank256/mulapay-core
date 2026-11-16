import { Injectable } from '@nestjs/common';
import {
  ScreeningUnavailableError,
  type SanctionsScreening,
  type ScreeningOutcome,
} from './sanctions-screening.port';

/**
 * Stands in when no screening provider is usable (none configured, or `complyadvantage`,
 * which has no adapter yet). Every call fails, so onboarding cannot be approved without a
 * real screening result: the system fails closed rather than treating silence as clear.
 */
@Injectable()
export class UnavailableScreening implements SanctionsScreening {
  readonly configured = false;

  screen(): Promise<ScreeningOutcome> {
    return Promise.reject(new ScreeningUnavailableError('no usable screening provider'));
  }
}
