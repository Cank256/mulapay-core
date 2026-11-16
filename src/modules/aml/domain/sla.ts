/** Alert SLAs (spec 6.13): how long an alert may wait before it escalates, by severity. */
import type { AppConfig } from '../../../config/configuration';
import type { Severity } from './rule-evaluation';

export type SlaConfig = Pick<
  AppConfig,
  | 'AML_ALERT_SLA_HOURS_LOW'
  | 'AML_ALERT_SLA_HOURS_MEDIUM'
  | 'AML_ALERT_SLA_HOURS_HIGH'
  | 'AML_ALERT_SLA_HOURS_CRITICAL'
>;

const HOUR_MS = 3_600_000;

export function slaHours(severity: Severity, config: SlaConfig): number {
  switch (severity) {
    case 'low':
      return config.AML_ALERT_SLA_HOURS_LOW;
    case 'medium':
      return config.AML_ALERT_SLA_HOURS_MEDIUM;
    case 'high':
      return config.AML_ALERT_SLA_HOURS_HIGH;
    case 'critical':
      return config.AML_ALERT_SLA_HOURS_CRITICAL;
  }
}

export function alertDueAt(severity: Severity, createdAt: Date, config: SlaConfig): Date {
  return new Date(createdAt.getTime() + slaHours(severity, config) * HOUR_MS);
}
