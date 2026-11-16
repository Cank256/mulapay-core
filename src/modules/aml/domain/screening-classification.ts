/**
 * What a screening result means (spec 6.13). Pure. The provider reports candidate matches
 * with scores; core decides, with its own thresholds, whether the result needs a person
 * (`potential_match`), is a match (`confirmed_match`) or can be ignored (`clear`).
 *
 * Both of the first two block activation. A potential match is decided by an analyst; a
 * confirmed match opens an AML case. Hits below the review score are not counted at all.
 */
import type {
  ScreeningCategory,
  ScreeningHit,
} from '../../../integrations/sanctions/sanctions-screening.port';

export type ScreeningStatus = 'clear' | 'potential_match' | 'confirmed_match';

export interface ScreeningThresholds {
  readonly review: number;
  readonly confirm: number;
}

export interface Classification {
  readonly status: ScreeningStatus;
  readonly hitCount: number;
  readonly highestScore: number | null;
  readonly lists: ScreeningCategory[];
  /** The hits at or above the review score, strongest first. */
  readonly hits: ScreeningHit[];
}

export function classifyScreening(
  hits: readonly ScreeningHit[],
  thresholds: ScreeningThresholds
): Classification {
  const relevant = hits
    .filter((h) => h.score >= thresholds.review)
    .sort((a, b) => b.score - a.score);
  const highest = relevant[0]?.score ?? null;
  const status: ScreeningStatus =
    highest === null
      ? 'clear'
      : highest >= thresholds.confirm
        ? 'confirmed_match'
        : 'potential_match';
  return {
    status,
    hitCount: relevant.length,
    highestScore: highest === null ? null : Math.round(highest * 1000) / 1000,
    lists: [...new Set(relevant.flatMap((h) => h.categories))].sort(),
    hits: relevant,
  };
}

/** Statuses that stop a merchant being activated. */
export function blocksActivation(status: ScreeningStatus): boolean {
  return status !== 'clear';
}
