/**
 * The HTTP side of webhook delivery, behind an interface so the delivery service is tested
 * against real HTTP servers without knowing how the request is made.
 *
 * Safety properties of `UndiciWebhookTransport` (spec 6.11, 11):
 *  - one POST per call, no redirects followed (a redirect could point at an internal host);
 *  - the destination address is validated when the connection is made, from the very
 *    addresses DNS returned (`lookup`), not from a second resolution, so DNS rebinding
 *    cannot swap a public name for an internal address between check and connect;
 *  - TLS certificates are verified;
 *  - 10 s to answer (headers and body), then the request is aborted;
 *  - only the first 1 KiB of the response is read, and the rest is discarded;
 *  - failures are reported as a short code, never the raw network error, which could name
 *    internal hosts.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, errors as undiciErrors, request } from 'undici';
import { DELIVERY_TIMEOUT_MS } from './domain/retry-schedule';
import { isPrivateAddress } from './domain/endpoint-url';

export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');
const EXCERPT_BYTES = 1024;

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type WebhookTransportResult =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly elapsedMs: number;
      readonly excerpt: string;
    }
  | {
      readonly kind: 'error';
      readonly outcome: 'timeout' | 'blocked' | 'network_error';
      readonly elapsedMs: number;
    };

export interface WebhookTransport {
  post(request: WebhookRequest): Promise<WebhookTransportResult>;
}

class BlockedAddressError extends Error {
  constructor() {
    super('webhook destination resolves to a private address');
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/** A `lookup` for `net.connect` that refuses any answer containing a private address. */
function safeLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (!allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
        return callback(new BlockedAddressError(), '');
      }
      const first = addresses[0];
      if (!first) return callback(new Error('no address'), '');
      return options.all ? callback(null, addresses) : callback(null, first.address, first.family);
    });
  };
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof undiciErrors.HeadersTimeoutError ||
    error instanceof undiciErrors.BodyTimeoutError ||
    error instanceof undiciErrors.ConnectTimeoutError ||
    (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

function isBlocked(error: unknown): boolean {
  if (error instanceof BlockedAddressError) return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof BlockedAddressError;
}

export class UndiciWebhookTransport implements WebhookTransport {
  private readonly agent: Agent;

  constructor(private readonly allowPrivateNetworks: boolean) {
    this.agent = new Agent({
      connect: { lookup: safeLookup(allowPrivateNetworks), timeout: DELIVERY_TIMEOUT_MS },
      headersTimeout: DELIVERY_TIMEOUT_MS,
      bodyTimeout: DELIVERY_TIMEOUT_MS,
    });
  }

  async post(input: WebhookRequest): Promise<WebhookTransportResult> {
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    const host = new URL(input.url).hostname.replace(/^\[|\]$/g, '');
    // An address given as a literal never reaches `lookup`, so check it here.
    if (!this.allowPrivateNetworks && isIP(host) !== 0 && isPrivateAddress(host)) {
      return { kind: 'error', outcome: 'blocked', elapsedMs: elapsed() };
    }
    try {
      const response = await request(input.url, {
        method: 'POST',
        headers: input.headers,
        body: input.body,
        dispatcher: this.agent,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      const excerpt = await readExcerpt(response.body);
      return { kind: 'response', status: response.statusCode, elapsedMs: elapsed(), excerpt };
    } catch (error) {
      const outcome = isBlocked(error) ? 'blocked' : isTimeout(error) ? 'timeout' : 'network_error';
      return { kind: 'error', outcome, elapsedMs: elapsed() };
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  /** Nest calls this on shutdown so open keep-alive sockets do not hold the process. */
  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}

/** The first KiB of the body as text; the remainder is discarded so a large reply costs nothing. */
async function readExcerpt(body: AsyncIterable<Buffer> & { destroy(): unknown }): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= EXCERPT_BYTES) break;
    }
  } finally {
    body.destroy();
  }
  // Control characters are dropped so the excerpt is safe to show and to store.
  return Buffer.concat(chunks)
    .subarray(0, EXCERPT_BYTES)
    .toString('utf8')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .slice(0, EXCERPT_BYTES);
}
