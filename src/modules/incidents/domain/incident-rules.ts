/**
 * Pure rules of incidents (spec 6.14), unit-tested without a database.
 *
 *  - Severity `sev1` is the worst. Raising severity means moving toward sev1.
 *  - Status moves freely among investigating, identified and monitoring; `resolved` is final.
 *  - The public status feed shows only what staff wrote as public, mapped to coarse components
 *    and a coarse impact. Everything else about an incident is internal: its title, services
 *    such as the ledger or the gateway, the merchants affected, the commander, internal updates
 *    and the postmortem.
 */
export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const OPEN_STATUSES = ['investigating', 'identified', 'monitoring'] as const;
export const INCIDENT_STATUSES = [...OPEN_STATUSES, 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** The services an incident can name. */
export const INCIDENT_SERVICES = [
  'api',
  'dashboard',
  'payments',
  'payouts',
  'settlements',
  'webhooks',
  'notifications',
  'reports',
  'ledger',
  'reconciliation',
  'gateway',
  'database',
  'queues',
  'consumer',
] as const;
export type IncidentService = (typeof INCIDENT_SERVICES)[number];

/** Only these appear publicly, under these names. Internal services are omitted. */
export const PUBLIC_COMPONENTS: Readonly<Record<string, string>> = {
  api: 'API',
  dashboard: 'Dashboard',
  payments: 'Payments',
  payouts: 'Payouts',
  settlements: 'Settlements',
  webhooks: 'Webhooks',
  notifications: 'Notifications',
  reports: 'Reports',
};

export function isOpen(status: IncidentStatus): boolean {
  return status !== 'resolved';
}

/** True when `to` is a worse severity than `from`. */
export function isEscalation(from: Severity, to: Severity): boolean {
  return SEVERITIES.indexOf(to) < SEVERITIES.indexOf(from);
}

export function worse(a: Severity, b: Severity): Severity {
  return isEscalation(a, b) ? b : a;
}

export type PublicImpact = 'minor' | 'major';
export function publicImpact(severity: Severity): PublicImpact {
  return severity === 'sev1' || severity === 'sev2' ? 'major' : 'minor';
}

export type OverallStatus = 'operational' | 'degraded' | 'major_outage';

/** The platform's headline status from the open public incidents. */
export function overallStatus(open: ReadonlyArray<{ severity: Severity }>): OverallStatus {
  if (open.length === 0) return 'operational';
  return open.some((i) => publicImpact(i.severity) === 'major') ? 'major_outage' : 'degraded';
}

/** The public component names for an incident's services, in a stable order, without internals. */
export function publicComponents(services: readonly string[]): string[] {
  const names = new Set<string>();
  for (const service of services) {
    const name = PUBLIC_COMPONENTS[service];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** Whether an incident can still be changed. A resolved one only takes a postmortem. */
export function canChange(status: IncidentStatus): boolean {
  return isOpen(status);
}
