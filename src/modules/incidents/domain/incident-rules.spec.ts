import { describe, expect, it } from 'vitest';
import {
  INCIDENT_SERVICES,
  PUBLIC_COMPONENTS,
  canChange,
  isEscalation,
  overallStatus,
  publicComponents,
  publicImpact,
  worse,
} from './incident-rules';

describe('incident severity', () => {
  it('treats sev1 as the worst', () => {
    expect(isEscalation('sev3', 'sev1')).toBe(true);
    expect(isEscalation('sev1', 'sev3')).toBe(false);
    expect(isEscalation('sev2', 'sev2')).toBe(false);
    expect(worse('sev3', 'sev2')).toBe('sev2');
    expect(worse('sev1', 'sev4')).toBe('sev1');
  });

  it('maps severity to a coarse public impact', () => {
    expect(publicImpact('sev1')).toBe('major');
    expect(publicImpact('sev2')).toBe('major');
    expect(publicImpact('sev3')).toBe('minor');
    expect(publicImpact('sev4')).toBe('minor');
  });

  it('summarises the platform from the open public incidents', () => {
    expect(overallStatus([])).toBe('operational');
    expect(overallStatus([{ severity: 'sev4' }])).toBe('degraded');
    expect(overallStatus([{ severity: 'sev4' }, { severity: 'sev2' }])).toBe('major_outage');
  });
});

describe('public components', () => {
  it('names only merchant-facing services and drops the internal ones', () => {
    expect(publicComponents(['ledger', 'payments', 'gateway', 'webhooks', 'database'])).toEqual([
      'Payments',
      'Webhooks',
    ]);
    expect(publicComponents(['ledger', 'consumer'])).toEqual([]);
  });

  it('never exposes a service name that is internal', () => {
    const internal = INCIDENT_SERVICES.filter((s) => !(s in PUBLIC_COMPONENTS));
    expect(internal).toEqual(
      expect.arrayContaining([
        'ledger',
        'reconciliation',
        'gateway',
        'database',
        'queues',
        'consumer',
      ])
    );
    for (const s of internal) expect(publicComponents([s])).toEqual([]);
  });
});

describe('incident status', () => {
  it('lets an open incident change and a resolved one not', () => {
    expect(canChange('investigating')).toBe(true);
    expect(canChange('identified')).toBe(true);
    expect(canChange('monitoring')).toBe(true);
    expect(canChange('resolved')).toBe(false);
  });
});
