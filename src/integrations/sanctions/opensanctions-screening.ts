/**
 * OpenSanctions `/match` adapter (https://www.opensanctions.org/docs/api/matching/).
 *
 * One query per call, against the `default` collection. A result is a sanctions hit when the
 * entity's `topics` include `sanction` and a PEP hit when they include `role.pep` or
 * `role.rca`; `SANCTIONS_LISTS` decides which of the two categories core acts on. The
 * provider's own `match` flag is not used: core applies its own review and confirm
 * thresholds to the score (`classifyScreening`).
 *
 * Failure handling: a timeout, a connection error, a non-2xx status or an answer that does
 * not have the documented shape is `ScreeningUnavailableError`. Nothing is inferred from it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { request } from 'undici';
import { z } from 'zod';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../common/tokens';
import {
  ScreeningUnavailableError,
  type SanctionsScreening,
  type ScreeningCategory,
  type ScreeningHit,
  type ScreeningOutcome,
  type ScreeningQuery,
} from './sanctions-screening.port';

const DEFAULT_BASE_URL = 'https://api.opensanctions.org';
const MAX_HITS = 10;

const responseSchema = z.object({
  responses: z.record(
    z.string(),
    z.object({
      status: z.number().optional(),
      results: z.array(
        z.object({
          id: z.string(),
          caption: z.string().default(''),
          score: z.number().min(0).max(1),
          datasets: z.array(z.string()).default([]),
          properties: z
            .object({ topics: z.array(z.string()).optional() })
            .passthrough()
            .default({}),
        })
      ),
    })
  ),
});

type SanctionsConfig = Pick<
  AppConfig,
  | 'SANCTIONS_PROVIDER'
  | 'SANCTIONS_API_KEY'
  | 'SANCTIONS_BASE_URL'
  | 'SANCTIONS_TIMEOUT_MS'
  | 'SANCTIONS_LISTS'
>;

@Injectable()
export class OpenSanctionsScreening implements SanctionsScreening {
  constructor(@Inject(APP_CONFIG) private readonly config: SanctionsConfig) {}

  get configured(): boolean {
    return this.config.SANCTIONS_PROVIDER === 'opensanctions' && !!this.config.SANCTIONS_API_KEY;
  }

  async screen(query: ScreeningQuery): Promise<ScreeningOutcome> {
    if (!this.configured) throw new ScreeningUnavailableError('no provider is configured');
    const categories = this.categories();
    const properties: Record<string, string[]> = { name: [query.name] };
    if (query.birthDate) properties.birthDate = [query.birthDate];
    if (query.country) properties.country = [query.country.toLowerCase()];
    let body: unknown;
    try {
      const res = await request(
        `${this.config.SANCTIONS_BASE_URL ?? DEFAULT_BASE_URL}/match/default`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `ApiKey ${this.config.SANCTIONS_API_KEY}`,
          },
          body: JSON.stringify({
            queries: {
              q: { schema: query.entityType === 'person' ? 'Person' : 'Organization', properties },
            },
          }),
          headersTimeout: this.config.SANCTIONS_TIMEOUT_MS,
          bodyTimeout: this.config.SANCTIONS_TIMEOUT_MS,
        }
      );
      if (res.statusCode < 200 || res.statusCode >= 300) {
        await res.body.dump();
        throw new ScreeningUnavailableError(`status ${res.statusCode}`);
      }
      body = await res.body.json();
    } catch (error) {
      if (error instanceof ScreeningUnavailableError) throw error;
      throw new ScreeningUnavailableError(error instanceof Error ? error.name : 'unknown error');
    }
    const parsed = responseSchema.safeParse(body);
    const result = parsed.success ? parsed.data.responses.q : undefined;
    if (!result || (result.status !== undefined && result.status !== 200)) {
      throw new ScreeningUnavailableError('unexpected response shape');
    }
    const hits: ScreeningHit[] = [];
    for (const entity of result.results.slice(0, MAX_HITS)) {
      const topics = entity.properties.topics ?? [];
      const found: ScreeningCategory[] = [];
      if (topics.includes('sanction') && categories.has('sanctions')) found.push('sanctions');
      if ((topics.includes('role.pep') || topics.includes('role.rca')) && categories.has('pep')) {
        found.push('pep');
      }
      if (found.length === 0) continue;
      hits.push({
        entityId: entity.id,
        caption: entity.caption,
        score: entity.score,
        categories: found,
        datasets: entity.datasets.slice(0, 20),
      });
    }
    return { provider: 'opensanctions', hits };
  }

  /** `PEP` in SANCTIONS_LISTS turns PEP hits on; any other code turns sanctions hits on. */
  private categories(): Set<ScreeningCategory> {
    const out = new Set<ScreeningCategory>();
    for (const list of this.config.SANCTIONS_LISTS) out.add(list === 'PEP' ? 'pep' : 'sanctions');
    return out;
  }
}
