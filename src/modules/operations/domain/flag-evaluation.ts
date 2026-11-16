/**
 * Whether a feature flag applies to a merchant (spec 6.14, 9.2 rule 8). Pure and deterministic:
 *
 *  - A disabled flag is off for everyone, including allow-listed merchants.
 *  - An allow-listed merchant is on.
 *  - Otherwise a merchant is on when its bucket (0..99, from a hash of the flag key and the
 *    merchant id) is below `rolloutPercent`. The same merchant always gets the same answer for
 *    a flag, and raising the percentage only ever adds merchants.
 *  - With no merchant (a platform-wide check), only a flag at 100% is on.
 */
import { createHash } from 'node:crypto';

export interface FlagState {
  readonly key: string;
  readonly enabled: boolean;
  readonly rolloutPercent: number;
  readonly merchantAllowlist: readonly string[];
}

/** 0..99, stable for a (flag, merchant) pair. */
export function rolloutBucket(key: string, merchantId: string): number {
  const digest = createHash('sha256').update(`${key}:${merchantId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function evaluateFlag(flag: FlagState, merchantId?: string): boolean {
  if (!flag.enabled) return false;
  if (merchantId === undefined) return flag.rolloutPercent >= 100;
  if (flag.merchantAllowlist.includes(merchantId)) return true;
  return rolloutBucket(flag.key, merchantId) < flag.rolloutPercent;
}
