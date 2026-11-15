/**
 * Associated-data context for a user's encrypted TOTP secret. Binding the ciphertext to
 * the user id means a secret copied onto another user's row does not decrypt.
 */
export function mfaSecretContext(userId: string): string {
  return `users.mfa_secret_enc:${userId}`;
}
