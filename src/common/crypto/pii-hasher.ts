/**
 * Keyed hashes of personal data for exact-match lookups (spec 11): the blocklist, counterparty
 * reuse and the TIN search column. The ciphertext of a value changes on every encryption, so
 * a deterministic HMAC under a secret pepper is the only thing that can be compared.
 *
 * Invariant: the same normalised value always gives the same digest within one deployment,
 * and without the pepper a digest cannot be tested against guesses. Production requires
 * `PII_HMAC_PEPPER` (env schema). Elsewhere, when it is unset, the key is derived from
 * `DATA_ENCRYPTION_KEY`, so development and tests work without a second secret; with neither
 * the hasher refuses to produce digests rather than hash with an empty key.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../errors/app-error';
import { APP_CONFIG } from '../tokens';

@Injectable()
export class PiiHasher {
  private readonly key: Buffer | undefined;

  constructor(
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'PII_HMAC_PEPPER' | 'DATA_ENCRYPTION_KEY'>
  ) {
    if (config.PII_HMAC_PEPPER) {
      this.key = Buffer.from(config.PII_HMAC_PEPPER, 'utf8');
    } else if (config.DATA_ENCRYPTION_KEY) {
      this.key = Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.from(config.DATA_ENCRYPTION_KEY, 'base64'),
          Buffer.alloc(0),
          'mulapay-core:pii-hmac:v1',
          32
        )
      );
    }
  }

  get available(): boolean {
    return this.key !== undefined;
  }

  /**
   * Hex HMAC-SHA256 of `value` under `namespace`, so an email and a phone number with the
   * same text can never collide, and a digest from one purpose is useless for another.
   */
  digest(namespace: string, value: string): string {
    if (!this.key) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        cause: new Error('neither PII_HMAC_PEPPER nor DATA_ENCRYPTION_KEY is configured'),
      });
    }
    return createHmac('sha256', this.key).update(`${namespace}\u0000${value}`).digest('hex');
  }
}
