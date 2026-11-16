/** One vendor HTTP call with a hard timeout. Never throws: a failure is a value. */
import { request } from 'undici';

export type HttpOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly json: unknown }
  | { readonly kind: 'failure'; readonly reason: 'timeout' | 'network' };

export async function callVendor(
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly timeoutMs: number;
  }
): Promise<HttpOutcome> {
  try {
    const res = await request(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      headersTimeout: init.timeoutMs,
      bodyTimeout: init.timeoutMs,
    });
    const text = await res.body.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { kind: 'response', status: res.statusCode, json };
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    const timedOut = code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
    return { kind: 'failure', reason: timedOut ? 'timeout' : 'network' };
  }
}

/** Maps a status the vendor gave to retry or not: 4xx other than 408/429 are final. */
export function isPermanentStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
