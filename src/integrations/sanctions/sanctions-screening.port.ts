/**
 * Sanctions and PEP screening behind an explicit interface (spec 4.4, 6.13). Core owns the
 * decision of what a result means; the provider only reports candidate matches.
 *
 * A screening is a read: asking twice is safe. A provider that does not answer gives no
 * result, and no result is never treated as "clear" (callers fail closed).
 */
export const SANCTIONS_SCREENING = Symbol('SANCTIONS_SCREENING');

export type ScreeningCategory = 'sanctions' | 'pep';

export interface ScreeningQuery {
  readonly entityType: 'person' | 'organization';
  readonly name: string;
  /** ISO date or year. Improves matching and cuts false positives. */
  readonly birthDate?: string;
  /** ISO 3166-1 alpha-2. */
  readonly country?: string;
}

export interface ScreeningHit {
  /** The provider's entity id. Enough to look the entity up; carries no personal data. */
  readonly entityId: string;
  readonly caption: string;
  /** 0..1 match confidence reported by the provider. */
  readonly score: number;
  readonly categories: readonly ScreeningCategory[];
  readonly datasets: readonly string[];
}

export interface ScreeningOutcome {
  readonly provider: string;
  readonly hits: readonly ScreeningHit[];
}

export interface SanctionsScreening {
  /** False when no provider is configured; `screen` then always throws. */
  readonly configured: boolean;
  screen(query: ScreeningQuery): Promise<ScreeningOutcome>;
}

/** The provider could not be reached or did not give a usable answer. Retrying may help. */
export class ScreeningUnavailableError extends Error {
  constructor(detail: string) {
    super(`sanctions screening unavailable: ${detail}`);
    this.name = 'ScreeningUnavailableError';
  }
}
