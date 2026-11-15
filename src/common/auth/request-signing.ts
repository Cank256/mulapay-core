/**
 * Request signing for the public API (spec 6.11). Pure: no I/O, so every branch is unit
 * tested.
 *
 *   X-MulaPay-Timestamp: <unix seconds>
 *   X-MulaPay-Signature: v1=<hex hmac-sha256>
 *   signing string: timestamp + "." + method + "." + path + "." + sha256(rawBody)
 *
 * `method` is upper case. `path` is the request target exactly as sent (path and query
 * string), so a proxy that rewrites the path breaks the signature rather than being
 * trusted. The key is the key's signing secret, used as the UTF-8 string it was issued as.
 *
 * Invariant: `verifySignature` compares the presented and expected MACs with
 * `crypto.timingSafeEqual` on buffers of equal, fixed length.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../crypto/crypto';

export const TIMESTAMP_HEADER = 'x-mulapay-timestamp';
export const SIGNATURE_HEADER = 'x-mulapay-signature';
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;

/** `timestamp.METHOD.path.sha256(rawBody)`. An absent body hashes as the empty string. */
export function signingString(
  timestamp: string,
  method: string,
  path: string,
  rawBody: Buffer | undefined
): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${sha256Hex(rawBody ?? '')}`;
}

/** The header value a client sends: `v1=` and the hex HMAC-SHA256 of the signing string. */
export function computeSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  rawBody: Buffer | undefined
): string {
  const mac = createHmac('sha256', secret)
    .update(signingString(timestamp, method, path, rawBody))
    .digest('hex');
  return `v1=${mac}`;
}

/** The 32 MAC bytes of a well-formed `v1=<64 hex>` header, or null. */
export function parseSignatureHeader(value: string): Buffer | null {
  const match = SIGNATURE_PATTERN.exec(value);
  return match?.[1] ? Buffer.from(match[1], 'hex') : null;
}

/** Unix seconds from a digits-only header, or null. */
export function parseTimestamp(value: string): number | null {
  if (!TIMESTAMP_PATTERN.test(value)) return null;
  return Number(value);
}

/** True when `timestamp` is within `toleranceSeconds` of `now`, in either direction. */
export function withinTolerance(timestamp: number, now: Date, toleranceSeconds: number): boolean {
  return Math.abs(Math.floor(now.getTime() / 1000) - timestamp) <= toleranceSeconds;
}

export function verifySignature(
  presented: Buffer,
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  rawBody: Buffer | undefined
): boolean {
  const expected = parseSignatureHeader(computeSignature(secret, timestamp, method, path, rawBody));
  return (
    expected !== null &&
    presented.length === expected.length &&
    timingSafeEqual(presented, expected)
  );
}
