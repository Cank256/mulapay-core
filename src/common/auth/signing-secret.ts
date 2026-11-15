/**
 * The signing secret of an API key (spec 6.11): the HMAC key for request signing.
 *
 * Unlike the key secret it cannot be stored as a hash, because the server recomputes the
 * HMAC. It is stored AES-256-GCM encrypted, bound to its key by the context string below, so
 * a ciphertext copied to another key fails to decrypt. It is shown once, at issue.
 */
import { randomBytes } from 'node:crypto';

/** `mpsig_` and 32 random bytes as hex. */
export function generateSigningSecret(): string {
  return `mpsig_${randomBytes(32).toString('hex')}`;
}

/** The associated data binding a stored signing secret to its key. */
export function signingSecretContext(apiKeyRef: string): string {
  return `api_keys.signing_secret:${apiKeyRef}`;
}
