/**
 * Revoked session ids (spec section 8.3: stateless JWT verification "with one Redis check
 * against a revoked-sid set").
 *
 * Each revoked `sid` is its own key with a TTL of one access-token lifetime: after that
 * every access token for the session has expired and the entry is no longer needed.
 * Postgres (`core.sessions.revoked_at`) is the source of truth; this store only makes
 * revocation take effect before the access token expires.
 *
 * Fails closed: if Redis cannot answer, the request is refused with 503.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../errors/app-error';
import { REDIS } from '../redis/redis.module';
import { APP_CONFIG } from '../tokens';

const KEY_PREFIX = 'auth:revoked-sid:';

@Injectable()
export class SessionRevocationStore {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'ACCESS_TOKEN_TTL'>
  ) {}

  async revoke(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const pipeline = this.redis.multi();
    // One extra minute covers the verifier's clock-skew allowance.
    for (const sid of sessionIds)
      pipeline.set(KEY_PREFIX + sid, '1', 'EX', this.config.ACCESS_TOKEN_TTL + 60);
    await pipeline.exec();
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(KEY_PREFIX + sessionId)) === 1;
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
    }
  }
}
