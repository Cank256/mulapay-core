/**
 * The Redis cache in front of API key authentication (spec 8.3).
 *
 *   apikey:{keyId}        the key and its merchant's status, 60 s
 *   apikey:neg:{keyId}    "no such key", 30 s, so guessed ids do not reach Postgres
 *   apikey:evict:{keyId}, apikey:evict-merchant:{merchantId}
 *                         eviction markers, 120 s: the Redis server time of the last change
 *
 * Invalidation is immediate and race-free. A change (revocation, expiry change, merchant
 * suspension) commits in Postgres first; then `evict` stamps a marker with the Redis clock
 * and deletes the entry. Every entry records the Redis time at which its database read
 * began (`readAtMs`). An entry is honoured only if it began after the latest marker, so a
 * slow reader that read the old row before the change and cached it after the delete is
 * still discarded. Markers outlive the entry TTL, so nothing stale can outlast them.
 *
 * Redis is an accelerator, never the authority: when it is unavailable the caller reads
 * Postgres. Nothing here holds financial state.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { toLoggableError } from '../logging/redaction';
import { REDIS } from '../redis/redis.module';
import { ROOT_LOGGER } from '../tokens';
import type { Environment, MerchantStatus } from './principal';

export const KEY_CACHE_TTL_SECONDS = 60;
export const KEY_NEGATIVE_TTL_SECONDS = 30;
const MARKER_TTL_SECONDS = 120;

/** What authentication needs about a key, as of `readAtMs`. */
export interface CachedApiKey {
  readonly id: string;
  readonly ref: string;
  readonly keyId: string;
  readonly name: string;
  readonly environment: Environment;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly ipAllowlist: readonly string[] | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly rateLimitRpm: number | null;
  readonly signingRequired: boolean;
  readonly signingSecretEnc: string | null;
  readonly merchantId: string;
  readonly merchantRef: string;
  readonly merchantStatus: MerchantStatus;
  /** Redis server time (ms) when the database read that produced this entry began. */
  readonly readAtMs: number;
}

/** What the database lookup returns: the key row and its merchant's ref and status. */
export interface KeyLookupSource {
  readonly key: {
    readonly id: string;
    readonly ref: string;
    readonly keyId: string;
    readonly name: string;
    readonly environment: string;
    readonly secretHash: string;
    readonly scopes: string[];
    readonly ipAllowlist: string[] | null;
    readonly expiresAt: Date | null;
    readonly revokedAt: Date | null;
    readonly rateLimitRpm: number | null;
    readonly signingRequired: boolean;
    readonly signingSecretEnc: string | null;
    readonly merchantId: string;
  };
  readonly merchantRef: string;
  readonly merchantStatus: string;
}

export type CacheLookup =
  | { readonly kind: 'hit'; readonly key: CachedApiKey }
  | { readonly kind: 'negative' }
  | { readonly kind: 'miss' };

const LOOKUP_SCRIPT = `
local entry = redis.call('GET', KEYS[1])
local negative = redis.call('GET', KEYS[2])
local keyMarker = redis.call('GET', KEYS[3])
local merchantMarker = false
if entry then
  local ok, decoded = pcall(cjson.decode, entry)
  if ok and decoded.merchantId then
    merchantMarker = redis.call('GET', ARGV[1] .. decoded.merchantId)
  end
end
return { entry or false, negative or false, keyMarker or false, merchantMarker or false }`;

const EVICT_SCRIPT = `
local t = redis.call('TIME')
local ms = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('SET', KEYS[1], ms, 'EX', ARGV[1])
if KEYS[2] then redis.call('DEL', KEYS[2]) end
return ms`;

@Injectable()
export class ApiKeyCache {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Redis server time in milliseconds. Throws if Redis is unavailable. */
  async serverTimeMs(): Promise<number> {
    const [seconds, micros] = await this.redis.time();
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  }

  /** Cache state of a key; any Redis failure is a plain miss (the caller reads Postgres). */
  async lookup(keyId: string): Promise<CacheLookup> {
    try {
      const reply = (await this.redis.eval(
        LOOKUP_SCRIPT,
        3,
        `apikey:${keyId}`,
        `apikey:neg:${keyId}`,
        `apikey:evict:${keyId}`,
        'apikey:evict-merchant:'
      )) as [string | null, string | null, string | null, string | null];
      const [entry, negative, keyMarker, merchantMarker] = reply;
      if (negative) return { kind: 'negative' };
      if (!entry) return { kind: 'miss' };
      const key = JSON.parse(entry) as CachedApiKey;
      const newestMarker = Math.max(Number(keyMarker || 0), Number(merchantMarker || 0));
      return key.readAtMs > newestMarker ? { kind: 'hit', key } : { kind: 'miss' };
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'api key cache unavailable');
      return { kind: 'miss' };
    }
  }

  async put(key: CachedApiKey): Promise<void> {
    try {
      await this.redis.set(`apikey:${key.keyId}`, JSON.stringify(key), 'EX', KEY_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'api key cache write failed');
    }
  }

  async putNegative(keyId: string): Promise<void> {
    try {
      await this.redis.set(`apikey:neg:${keyId}`, '1', 'EX', KEY_NEGATIVE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'api key negative cache write failed');
    }
  }

  /**
   * Drops one key from every replica's view. Call after the change has committed. Throws if
   * Redis cannot be reached, so the caller can report that revocation is delayed by at most
   * the cache TTL.
   */
  async evict(keyId: string): Promise<void> {
    await this.redis.eval(
      EVICT_SCRIPT,
      2,
      `apikey:evict:${keyId}`,
      `apikey:${keyId}`,
      MARKER_TTL_SECONDS
    );
  }

  /** Drops every key of a merchant (suspension, closure): the marker covers all of them. */
  async evictMerchant(merchantId: string): Promise<void> {
    await this.redis.eval(
      EVICT_SCRIPT,
      1,
      `apikey:evict-merchant:${merchantId}`,
      MARKER_TTL_SECONDS
    );
  }
}
