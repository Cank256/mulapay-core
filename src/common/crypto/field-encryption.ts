/**
 * AES-256-GCM encryption for secrets stored in the database (spec section 11): MFA
 * secrets now, webhook secrets and payout destinations later.
 *
 * Format: `v1.{keyId}.{iv}.{tag}.{ciphertext}`, base64url parts. `keyId` identifies the
 * data key so a rotation can tell which key decrypts a value. Every value is bound to a
 * context string (for example `users.mfa_secret:{userId}`) as associated data, so a
 * ciphertext copied to another row or column fails to decrypt.
 *
 * KMS-wrapped data keys (KMS_KEY_ID) are not supported yet. With KMS_KEY_ID set the
 * service refuses to encrypt or decrypt rather than treating the wrapped key as raw.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../errors/app-error';
import { APP_CONFIG } from '../tokens';
import { sha256Hex } from './crypto';

const VERSION = 'v1';
const IV_BYTES = 12;

@Injectable()
export class FieldEncryption {
  private readonly key: Buffer | undefined;
  private readonly keyId: string | undefined;

  constructor(@Inject(APP_CONFIG) config: Pick<AppConfig, 'DATA_ENCRYPTION_KEY' | 'KMS_KEY_ID'>) {
    if (config.DATA_ENCRYPTION_KEY && !config.KMS_KEY_ID) {
      this.key = Buffer.from(config.DATA_ENCRYPTION_KEY, 'base64');
      this.keyId = sha256Hex(this.key).slice(0, 12);
    }
  }

  /** True when a data key is configured and values can be encrypted. */
  get available(): boolean {
    return this.key !== undefined;
  }

  encrypt(plaintext: string, context: string): string {
    const { key, keyId } = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, keyId, iv, tag, ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  /** Throws if the value was tampered with, bound to another context, or uses another key. */
  decrypt(value: string, context: string): string {
    const { key, keyId } = this.requireKey();
    const [version, valueKeyId, iv, tag, ciphertext, ...rest] = value.split('.');
    if (
      version !== VERSION ||
      valueKeyId !== keyId ||
      iv === undefined ||
      tag === undefined ||
      ciphertext === undefined ||
      rest.length > 0
    ) {
      throw new Error('encrypted value has an unknown format or key');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private requireKey(): { key: Buffer; keyId: string } {
    if (!this.key || !this.keyId) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        cause: new Error('DATA_ENCRYPTION_KEY is not configured (or KMS unwrapping is required)'),
      });
    }
    return { key: this.key, keyId: this.keyId };
  }
}
