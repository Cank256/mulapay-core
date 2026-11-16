/**
 * Rules of the automatic incident monitors (spec 6.14, 10), pure and unit-tested.
 *
 * A monitor watches a condition. It opens an incident only once the condition has lasted its
 * sustain time, so a blip does not page anyone, and it raises the severity as the condition
 * gets worse or lasts longer. A cleared condition moves the incident to `monitoring` for a
 * person to resolve; the monitor never resolves one.
 *
 * Severity rules (the values are configuration; docs/ARCHITECTURE.md lists them):
 *   ledger integrity   sev1 at once                                    (reconciliation run, Phase 6)
 *   suspense drift     sev2 once non-zero for SUSPENSE_ALERT_HOURS, sev1 after OPS_SUSPENSE_SEV1_HOURS
 *   stuck transactions sev3 at once, sev2 when the oldest is older than OPS_STUCK_TXN_SEV2_MINUTES
 *   queue depth        sev3 above the threshold for the sustain time, sev2 above five times it
 */
import type { Severity } from '../../incidents/domain/incident-rules';

export interface SignalReading {
  /** Whether the condition holds now. */
  readonly active: boolean;
  readonly severity: Severity;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface SignalState {
  readonly activeSince: Date | null;
}

export type SignalDecision =
  | { readonly action: 'clear'; readonly wasActive: boolean }
  | { readonly action: 'wait'; readonly activeSince: Date }
  | { readonly action: 'open'; readonly activeSince: Date; readonly severity: Severity };

/** What a monitor does with a reading, given how long the condition has been seen. */
export function decide(
  reading: SignalReading,
  state: SignalState,
  now: Date,
  sustainSeconds: number
): SignalDecision {
  if (!reading.active) return { action: 'clear', wasActive: state.activeSince !== null };
  const activeSince = state.activeSince ?? now;
  const lasted = (now.getTime() - activeSince.getTime()) / 1000;
  if (lasted < sustainSeconds) return { action: 'wait', activeSince };
  return { action: 'open', activeSince, severity: reading.severity };
}

export function suspenseSeverity(nonZeroForSeconds: number, sev1AfterHours: number): Severity {
  return nonZeroForSeconds >= sev1AfterHours * 3600 ? 'sev1' : 'sev2';
}

export function stuckSeverity(oldestAgeMinutes: number, sev2AfterMinutes: number): Severity {
  return oldestAgeMinutes >= sev2AfterMinutes ? 'sev2' : 'sev3';
}

export function queueDepthSeverity(depth: number, threshold: number): Severity {
  return depth >= threshold * 5 ? 'sev2' : 'sev3';
}
