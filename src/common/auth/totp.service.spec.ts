import { generateSync } from 'otplib';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../test/support/fixed-clock';
import { PasswordHasher } from './password-hasher';
import { TotpService } from './totp.service';

describe('TotpService', () => {
  const clock = new FixedClock('2025-01-01T00:00:00.000Z');
  const totp = new TotpService({ MFA_ISSUER: 'MulaPay' }, clock);
  const secret = totp.generateSecret();
  const codeAt = (offsetSeconds: number) =>
    generateSync({ secret, epoch: Math.floor(clock.now().getTime() / 1000) + offsetSeconds });

  it('accepts the current code and one step of drift', async () => {
    expect(await totp.verify(secret, codeAt(0), null)).toBe(
      Math.floor(clock.now().getTime() / 30_000)
    );
    expect(await totp.verify(secret, codeAt(-30), null)).not.toBeNull();
    expect(await totp.verify(secret, codeAt(30), null)).not.toBeNull();
    expect(await totp.verify(secret, codeAt(-90), null)).toBeNull();
  });

  it('refuses replays at or before the last used step and malformed codes', async () => {
    const step = await totp.verify(secret, codeAt(0), null);
    expect(await totp.verify(secret, codeAt(0), step)).toBeNull();
    expect(await totp.verify(secret, '12345', null)).toBeNull();
    expect(await totp.verify(secret, 'abcdef', null)).toBeNull();
  });

  it('builds an otpauth URI with the issuer', () => {
    expect(totp.uri('ada@example.com', secret)).toMatch(/^otpauth:\/\/totp\/.*issuer=MulaPay/);
  });
});

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('hashes with argon2id at the spec parameters and verifies', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(await hasher.verify('not-a-hash', 'x')).toBe(false);
    expect(await hasher.verifyAgainstDummy('anything')).toBe(false);
  });
});
