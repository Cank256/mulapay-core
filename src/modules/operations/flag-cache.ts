/**
 * A short in-process cache of feature flags (spec 9.2 rule 8: 30 seconds). A write clears the
 * cache of the process that made it; the other processes pick the change up when their entry
 * expires. (The spec asks for Redis pub/sub invalidation; see docs/ARCHITECTURE.md.)
 */
import { Injectable } from '@nestjs/common';
import type { FlagState } from './domain/flag-evaluation';

export const FLAG_CACHE_TTL_MS = 30_000;

@Injectable()
export class FlagCache {
  private entries: { at: number; flags: Map<string, FlagState> } | undefined;

  get(now: number): Map<string, FlagState> | undefined {
    if (!this.entries || now - this.entries.at >= FLAG_CACHE_TTL_MS) return undefined;
    return this.entries.flags;
  }

  set(now: number, flags: Map<string, FlagState>): void {
    this.entries = { at: now, flags };
  }

  clear(): void {
    this.entries = undefined;
  }
}
