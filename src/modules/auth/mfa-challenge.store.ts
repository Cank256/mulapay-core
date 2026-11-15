/**
 * MFA login challenges: after a correct password for an MFA-enabled account, the client
 * receives an opaque challenge token and exchanges it plus a TOTP code for a session.
 *
 * Stored in Redis under the token's SHA-256 for 5 minutes, single use, and discarded
 * after 5 wrong codes. Losing Redis only forces the user to enter the password again.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../../common/crypto/crypto';
import { AppError } from '../../common/errors/app-error';
import { REDIS } from '../../common/redis/redis.module';

export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

const challengeSchema = z.object({
  userId: z.string(),
  surface: z.enum(['dashboard', 'admin']),
  merchantId: z.string().nullable(),
  attempts: z.number().int(),
});
export type MfaChallenge = z.infer<typeof challengeSchema>;

@Injectable()
export class MfaChallengeStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async create(challenge: Omit<MfaChallenge, 'attempts'>): Promise<string> {
    const token = randomToken(32);
    await this.guard(() =>
      this.redis.set(
        this.key(token),
        JSON.stringify({ ...challenge, attempts: 0 }),
        'EX',
        MFA_CHALLENGE_TTL_SECONDS
      )
    );
    return token;
  }

  async get(token: string): Promise<MfaChallenge | null> {
    const raw = await this.guard(() => this.redis.get(this.key(token)));
    if (!raw) return null;
    const parsed = challengeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  /** Counts a wrong code; the challenge is discarded at the attempt limit. */
  async recordFailure(token: string, challenge: MfaChallenge): Promise<void> {
    const attempts = challenge.attempts + 1;
    await this.guard<unknown>(() =>
      attempts >= MFA_CHALLENGE_MAX_ATTEMPTS
        ? this.redis.del(this.key(token))
        : this.redis.set(this.key(token), JSON.stringify({ ...challenge, attempts }), 'KEEPTTL')
    );
  }

  /** Single use: true only for the one caller that removes the challenge. */
  async consume(token: string): Promise<boolean> {
    return (await this.guard(() => this.redis.del(this.key(token)))) === 1;
  }

  private key(token: string): string {
    return `auth:mfa-challenge:${sha256Hex(token)}`;
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new AppError('SERVICE_UNAVAILABLE', { cause: error });
    }
  }
}
