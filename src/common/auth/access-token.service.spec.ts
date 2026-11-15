import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../test/support/fixed-clock';
import { AccessTokenService, type AccessTokenSubject } from './access-token.service';

function pem() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    keyObject: privateKey,
  };
}

const subject: AccessTokenSubject = {
  aud: 'dashboard',
  sub: 'usr_1',
  type: 'merchant_user',
  merchantId: 'mch_1',
  roles: ['owner'],
  sid: 'ses_1',
  mfa: false,
  amr: ['pwd'],
  auth_time: 1735689600,
};

function service(keys: ReturnType<typeof pem>, clock: FixedClock, previous?: string, kid = 'k2') {
  return new AccessTokenService(
    {
      JWT_PRIVATE_KEY: keys.privateKey,
      JWT_PUBLIC_KEY: keys.publicKey,
      JWT_PREVIOUS_PUBLIC_KEY: previous,
      JWT_KID: kid,
      ACCESS_TOKEN_TTL: 600,
    },
    clock
  );
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

describe('AccessTokenService', () => {
  const clock = new FixedClock('2025-01-01T00:00:00.000Z');
  const keys = pem();
  const tokens = service(keys, clock);

  it('issues an EdDSA JWT with kid that verifies for its audience', () => {
    const { token, expiresAt } = tokens.issue(subject);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString());
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'k2' });
    expect(expiresAt.toISOString()).toBe('2025-01-01T00:10:00.000Z');
    const claims = tokens.verify(token, 'dashboard');
    expect(claims).toMatchObject({ ...subject, iss: 'mulapay-core', exp: claims!.iat + 600 });
  });

  it('refuses the other audience, expiry, tampering and malformed tokens', () => {
    const { token } = tokens.issue(subject);
    expect(tokens.verify(token, 'admin')).toBeNull();
    const [h, p, s] = token.split('.');
    const tampered = b64({
      ...JSON.parse(Buffer.from(p ?? '', 'base64url').toString()),
      roles: ['admin'],
    });
    expect(tokens.verify(`${h}.${tampered}.${s}`, 'dashboard')).toBeNull();
    expect(tokens.verify('a.b', 'dashboard')).toBeNull();
    expect(tokens.verify('a.b.c', 'dashboard')).toBeNull();
    expect(tokens.verify(`${h}.${p}.${s}=`, 'dashboard')).toBeNull();
    const later = new FixedClock('2025-01-01T00:10:00.000Z');
    expect(service(keys, later).verify(token, 'dashboard')).toBeNull();
  });

  it('refuses alg none and tokens issued in the future', () => {
    const { token } = tokens.issue(subject);
    const [, p, s] = token.split('.');
    expect(
      tokens.verify(`${b64({ alg: 'none', typ: 'JWT', kid: 'k2' })}.${p}.${s}`, 'dashboard')
    ).toBeNull();
    const future = service(keys, new FixedClock('2025-01-01T01:00:00.000Z')).issue(subject).token;
    expect(tokens.verify(future, 'dashboard')).toBeNull();
  });

  it('refuses a correctly signed token with unexpected claims', () => {
    const header = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k2' });
    const payload = b64({
      ...subject,
      iss: 'mulapay-core',
      iat: 1735689600,
      exp: 1735690200,
      jti: 'j',
      extra: 1,
    });
    const signature = sign(null, Buffer.from(`${header}.${payload}`), keys.keyObject).toString(
      'base64url'
    );
    expect(tokens.verify(`${header}.${payload}.${signature}`, 'dashboard')).toBeNull();
  });

  it('verifies tokens of the previous key during rotation, by kid', () => {
    const old = pem();
    const oldToken = service(old, clock, undefined, 'k1').issue(subject).token;
    expect(service(keys, clock).verify(oldToken, 'dashboard')).toBeNull();
    expect(service(keys, clock, old.publicKey).verify(oldToken, 'dashboard')).not.toBeNull();
  });

  it('cannot issue without keys', () => {
    const none = new AccessTokenService(
      {
        JWT_PRIVATE_KEY: undefined,
        JWT_PUBLIC_KEY: undefined,
        JWT_PREVIOUS_PUBLIC_KEY: undefined,
        JWT_KID: undefined,
        ACCESS_TOKEN_TTL: 600,
      },
      clock
    );
    expect(() => none.issue(subject)).toThrow(
      expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' })
    );
    expect(none.verify(tokens.issue(subject).token, 'dashboard')).toBeNull();
  });
});
