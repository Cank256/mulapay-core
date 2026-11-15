/**
 * Replay protection for signed requests (spec 6.11): a verified signature is remembered in
 * Redis, and a second request with the same signature is refused.
 *
 * The entry must outlive every moment at which the signature could still verify. A
 * timestamp is accepted from `ts - tolerance` to `ts + tolerance`, so a signature stays
 * acceptable for up to twice the tolerance; the TTL is that long. Storing it for the skew
 * window alone would let a request captured near the end of the window be replayed once the
 * entry expired but the timestamp still passed.
 *
 * Redis down means no replay protection, so the check fails closed (503): a signed
 * request is never accepted without it.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../errors/app-error';
import { REDIS } from '../redis/redis.module';
import { APP_CONFIG } from '../tokens';

@Injectable()
export class SignatureReplayStore {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'SIGNATURE_TOLERANCE_SECONDS'>
  ) {}

  /** True the first time this (key, signature) is seen; false for a replay. */
  async claim(apiKeyId: string, signatureHex: string): Promise<boolean> {
    try {
      const set = await this.redis.set(
        `sigreplay:${apiKeyId}:${signatureHex}`,
        '1',
        'EX',
        this.config.SIGNATURE_TOLERANCE_SECONDS * 2 + 5,
        'NX'
      );
      return set === 'OK';
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
    }
  }
}
