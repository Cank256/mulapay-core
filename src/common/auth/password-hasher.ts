/**
 * Password hashing with argon2id (spec section 8.3: memoryCost 19456 KiB, timeCost 2,
 * parallelism 1).
 *
 * `verifyAgainstDummy` runs a full verification against a fixed hash so an unknown email
 * costs the same argon2 work as a wrong password (identical timing, spec 8.3).
 */
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Password policy: 8–128 characters, with at least one uppercase letter, one lowercase
 * letter, one digit, and one special character (% @ $ # ^ & * ? |).
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

@Injectable()
export class PasswordHasher {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= argon2.hash('mulapay-dummy-password-for-timing', ARGON2_OPTIONS);
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
