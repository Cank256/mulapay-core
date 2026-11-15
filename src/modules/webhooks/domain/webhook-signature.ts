/**
 * Signature of a webhook delivery (spec 6.11), Stripe-compatible in shape:
 *
 *   MulaPay-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "t.payload">
 *
 * `payload` is the exact request body. During a secret rotation the header carries one
 * `v1` per live secret, so a receiver that still holds the old secret verifies against it.
 * Pure: `verifyWebhookSignature` is what merchants (and our tests) run on receipt.
 *
 * Replay safety: `t` is fresh on every attempt and covered by the MAC, so a receiver that
 * rejects a `t` older than its tolerance refuses a captured delivery; `MulaPay-Event-Id`
 * is stable across attempts and replays, so it deduplicates.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_HEADER = 'MulaPay-Signature';
export const DEFAULT_TOLERANCE_SECONDS = 300;

function mac(secret: string, timestamp: number, payload: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

/** Header value signing `payload` at `timestamp` with every secret in `secrets`. */
export function signWebhook(
  secrets: readonly string[],
  timestamp: number,
  payload: string
): string {
  const signatures = secrets.map((secret) => `v1=${mac(secret, timestamp, payload)}`);
  return [`t=${timestamp}`, ...signatures].join(',');
}

export type WebhookVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'malformed' | 'stale' | 'mismatch' };

/**
 * Verifies a `MulaPay-Signature` header against the raw body. Accepts any `v1` entry that
 * matches (constant-time) and a timestamp within `toleranceSeconds` of `nowSeconds`.
 */
export function verifyWebhookSignature(
  header: string,
  payload: string,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS
): WebhookVerification {
  let timestamp: number | undefined;
  const candidates: Buffer[] = [];
  for (const part of header.split(',')) {
    const [name, value, ...rest] = part.split('=');
    if (rest.length > 0 || value === undefined) return { valid: false, reason: 'malformed' };
    if (name === 't' && /^[0-9]{1,12}$/.test(value)) timestamp = Number(value);
    if (name === 'v1' && /^[0-9a-f]{64}$/.test(value)) candidates.push(Buffer.from(value, 'hex'));
  }
  if (timestamp === undefined || candidates.length === 0) {
    return { valid: false, reason: 'malformed' };
  }
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { valid: false, reason: 'stale' };
  const expected = Buffer.from(mac(secret, timestamp, payload), 'hex');
  // No early exit: every candidate is compared, so timing does not reveal which matched.
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched ? { valid: true } : { valid: false, reason: 'mismatch' };
}
