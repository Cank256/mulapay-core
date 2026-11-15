/**
 * Access tokens (spec section 8.3): JWT signed with Ed25519, `kid` in the header,
 * `ACCESS_TOKEN_TTL` lifetime (default 10 minutes).
 *
 * Two keys can be live at once for rotation: tokens whose `kid` equals `JWT_KID` verify
 * with `JWT_PUBLIC_KEY`, any other `kid` with `JWT_PREVIOUS_PUBLIC_KEY` when it is set.
 *
 * Verification is strict: exactly `alg: EdDSA` (no `none`, no algorithm switching), a
 * well-formed compact serialisation, the expected issuer and audience, and an unexpired
 * token. Any failure returns null; the reason is never sent to the client.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../../config/configuration';
import type { Clock } from '../clock/clock';
import { randomToken } from '../crypto/crypto';
import { AppError } from '../errors/app-error';
import { APP_CONFIG, CLOCK } from '../tokens';

export const TOKEN_ISSUER = 'mulapay-core';
export type TokenAudience = 'dashboard' | 'admin';
export type AuthMethod = 'pwd' | 'otp';

const MAX_CLOCK_SKEW_SECONDS = 60;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const headerSchema = z.object({ alg: z.literal('EdDSA'), typ: z.literal('JWT'), kid: z.string() });

const claimsSchema = z.strictObject({
  iss: z.literal(TOKEN_ISSUER),
  aud: z.enum(['dashboard', 'admin']),
  sub: z.string().min(1),
  type: z.enum(['merchant_user', 'staff']),
  merchantId: z.string().nullable(),
  roles: z.array(z.string()),
  sid: z.string().min(1),
  mfa: z.boolean(),
  amr: z.array(z.enum(['pwd', 'otp'])),
  auth_time: z.number().int(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
});

export type AccessTokenClaims = z.infer<typeof claimsSchema>;
export type AccessTokenSubject = Omit<AccessTokenClaims, 'iss' | 'iat' | 'exp' | 'jti'>;

function b64(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function parseJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

@Injectable()
export class AccessTokenService {
  private readonly privateKey?: KeyObject;
  private readonly publicKey?: KeyObject;
  private readonly previousPublicKey?: KeyObject;
  private readonly kid?: string;
  readonly ttlSeconds: number;

  constructor(
    @Inject(APP_CONFIG)
    config: Pick<
      AppConfig,
      | 'JWT_PRIVATE_KEY'
      | 'JWT_PUBLIC_KEY'
      | 'JWT_PREVIOUS_PUBLIC_KEY'
      | 'JWT_KID'
      | 'ACCESS_TOKEN_TTL'
    >,
    @Inject(CLOCK) private readonly clock: Clock
  ) {
    // The env schema has already checked the keys are Ed25519 and match each other.
    if (config.JWT_PRIVATE_KEY && config.JWT_PUBLIC_KEY && config.JWT_KID) {
      this.privateKey = createPrivateKey(config.JWT_PRIVATE_KEY);
      this.publicKey = createPublicKey(config.JWT_PUBLIC_KEY);
      this.kid = config.JWT_KID;
    }
    if (config.JWT_PREVIOUS_PUBLIC_KEY) {
      this.previousPublicKey = createPublicKey(config.JWT_PREVIOUS_PUBLIC_KEY);
    }
    this.ttlSeconds = config.ACCESS_TOKEN_TTL;
  }

  issue(subject: AccessTokenSubject): { token: string; expiresAt: Date } {
    if (!this.privateKey || !this.kid) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        cause: new Error('JWT signing keys are not configured'),
      });
    }
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const claims: AccessTokenClaims = {
      iss: TOKEN_ISSUER,
      ...subject,
      iat,
      exp: iat + this.ttlSeconds,
      jti: randomToken(12),
    };
    const signingInput = `${b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.kid }))}.${b64(JSON.stringify(claims))}`;
    const signature = sign(null, Buffer.from(signingInput), this.privateKey);
    return { token: `${signingInput}.${b64(signature)}`, expiresAt: new Date(claims.exp * 1000) };
  }

  /** Returns the claims of a valid token for `audience`, or null. */
  verify(token: string, audience: TokenAudience): AccessTokenClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => BASE64URL.test(p))) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = headerSchema.safeParse(parseJson(headerPart));
    if (!header.success) return null;
    const key = header.data.kid === this.kid ? this.publicKey : this.previousPublicKey;
    if (!key) return null;
    const valid = verify(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, 'base64url')
    );
    if (!valid) return null;
    const claims = claimsSchema.safeParse(parseJson(payloadPart));
    if (!claims.success || claims.data.aud !== audience) return null;
    const now = Math.floor(this.clock.now().getTime() / 1000);
    if (claims.data.exp <= now || claims.data.iat > now + MAX_CLOCK_SKEW_SECONDS) return null;
    return claims.data;
  }
}
