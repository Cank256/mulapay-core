/**
 * Small cryptographic helpers shared by authentication, API keys and the audit chain.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Uniformly random string over [a-z0-9]; `randomInt` avoids modulo bias. */
export function randomAlphanumeric(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += LOWER_ALNUM.charAt(randomInt(LOWER_ALNUM.length));
  return out;
}

/**
 * Constant-time string comparison. Inputs are hashed first so differing lengths do not
 * leak through an early return.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}
