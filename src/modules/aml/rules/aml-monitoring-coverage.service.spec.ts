import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../test/support/fixed-clock';
import { metricsRegistry } from '../../../common/telemetry/metrics';
import type { AmlRulesRepository } from './aml-rules.repository';
import { AmlMonitoringCoverageService } from './aml-monitoring-coverage.service';

function build(count: number | Error, role: 'api' | 'worker' | 'consumer' = 'api') {
  const repository = {
    countInEffect: vi.fn(() =>
      count instanceof Error ? Promise.reject(count) : Promise.resolve(count)
    ),
  };
  const logger = { warn: vi.fn() };
  const service = new AmlMonitoringCoverageService(
    repository as unknown as AmlRulesRepository,
    new FixedClock('2031-06-15T10:00:00.000Z'),
    { APP_ROLE: role },
    logger as unknown as Logger
  );
  return { service, repository, logger };
}

describe('AmlMonitoringCoverageService', () => {
  it('warns at boot when no rule is in effect and sets the gauge to 0', async () => {
    const { service, logger, repository } = build(0);
    await service.onApplicationBootstrap();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[1])).toMatch(/no AML monitoring rule is enabled/);
    expect(repository.countInEffect).toHaveBeenCalledWith(new Date('2031-06-15T10:00:00.000Z'));
    expect(await metricsRegistry.getSingleMetricAsString('core_aml_rules_enabled')).toMatch(
      /^core_aml_rules_enabled\{[^}]*\} 0$/m
    );
  });
  it('is silent when at least one rule is in effect, and reports the count', async () => {
    const { service, logger } = build(3);
    await service.onApplicationBootstrap();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await metricsRegistry.getSingleMetricAsString('core_aml_rules_enabled')).toMatch(
      /^core_aml_rules_enabled\{[^}]*\} 3$/m
    );
  });
  it('only checks in the api process', async () => {
    for (const role of ['worker', 'consumer'] as const) {
      const { service, repository, logger } = build(0, role);
      await service.onApplicationBootstrap();
      expect(repository.countInEffect).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });
  it('never fails boot when the table cannot be read', async () => {
    const { service, logger } = build(new Error('connection refused'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(String(logger.warn.mock.calls[0]?.[1])).toMatch(/coverage check failed/);
  });
});
