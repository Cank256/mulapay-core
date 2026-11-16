/**
 * An in-process stand-in for the OpenSanctions `/match` API, speaking the documented request
 * and response shapes (https://www.opensanctions.org/docs/api/matching/). The test decides, by
 * name, what the provider answers: a sanctions hit, a PEP hit, a weak hit, an error. Names it
 * has no rule for come back with no hits.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeHit {
  readonly id: string;
  readonly caption: string;
  readonly score: number;
  readonly topics: readonly string[];
  readonly datasets?: readonly string[];
}

export interface FakeSanctions {
  readonly baseUrl: string;
  /** Names received, in order. The provider does see names; the database does not store them. */
  readonly received: string[];
  /** Hits to return when the queried name contains `fragment` (case-insensitive). */
  respond(fragment: string, hits: readonly FakeHit[]): void;
  /** Every request answers this status until set back to null. */
  failWith: number | null;
  readonly calls: { count: number };
  config(overrides?: Record<string, string>): Record<string, string>;
  close(): Promise<void>;
}

export const SANCTIONS_KEY = 'test-sanctions-key';

export async function startFakeSanctions(): Promise<FakeSanctions> {
  const rules: Array<{ fragment: string; hits: readonly FakeHit[] }> = [];
  const received: string[] = [];
  const state = { failWith: null as number | null };
  const calls = { count: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      calls.count += 1;
      if (state.failWith) {
        res.writeHead(state.failWith).end('{}');
        return;
      }
      if (req.url !== '/match/default' || req.headers.authorization !== `ApiKey ${SANCTIONS_KEY}`) {
        res.writeHead(401).end('{}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        queries: { q: { properties: { name: string[] } } };
      };
      const name = body.queries.q.properties.name[0] ?? '';
      received.push(name);
      const rule = rules.find((r) => name.toLowerCase().includes(r.fragment.toLowerCase()));
      const results = (rule?.hits ?? []).map((h) => ({
        id: h.id,
        caption: h.caption,
        schema: 'Person',
        score: h.score,
        match: h.score >= 0.7,
        datasets: h.datasets ?? ['test_list'],
        properties: { topics: [...h.topics] },
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          responses: { q: { status: 200, results, total: { value: results.length } } },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    received,
    respond: (fragment, hits) => void rules.push({ fragment, hits }),
    get failWith() {
      return state.failWith;
    },
    set failWith(value: number | null) {
      state.failWith = value;
    },
    calls,
    config: (overrides = {}) => ({
      SANCTIONS_PROVIDER: 'opensanctions',
      SANCTIONS_API_KEY: SANCTIONS_KEY,
      SANCTIONS_BASE_URL: baseUrl,
      SANCTIONS_TIMEOUT_MS: '2000',
      SANCTIONS_LISTS: 'UN,OFAC,EU,UK,PEP',
      ...overrides,
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
