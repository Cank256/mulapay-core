/**
 * Tells operators when AML monitoring watches nothing (P7-C2).
 *
 * The eight seeded rules are all disabled until Compliance reviews and enables them, so a fresh
 * production deployment monitors no transaction and, until now, said nothing about it. This
 * service reports the number of rules in effect as `core_aml_rules_enabled` (alert at 0) and
 * logs a warning when the api process boots with none. It never blocks boot or readiness: an
 * unreadable table is logged and skipped, because the rules, not this check, decide what is
 * monitored.
 */
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../../common/clock/clock';
import { toLoggableError } from '../../../common/logging/redaction';
import { amlRulesEnabled, metricRefreshers } from '../../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import { AmlRulesRepository } from './aml-rules.repository';

@Injectable()
export class AmlMonitoringCoverageService implements OnApplicationBootstrap {
  constructor(
    private readonly rules: AmlRulesRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'APP_ROLE'>,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {
    metricRefreshers.set('aml_rules_enabled', async () => {
      await this.refresh();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.APP_ROLE !== 'api') return;
    try {
      const enabled = await this.refresh();
      if (enabled === 0) {
        this.logger.warn(
          { enabledRules: 0 },
          'no AML monitoring rule is enabled: no transaction is monitored until Compliance enables rules'
        );
      }
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'AML monitoring coverage check failed');
    }
  }

  /** Counts the rules in effect now and sets the gauge. */
  async refresh(): Promise<number> {
    const enabled = await this.rules.countInEffect(this.clock.now());
    amlRulesEnabled.set(enabled);
    return enabled;
  }
}
