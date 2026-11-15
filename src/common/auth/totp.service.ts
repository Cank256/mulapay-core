/**
 * TOTP (RFC 6238) with otplib: 6 digits, 30-second steps, SHA-1, as authenticator apps
 * expect. One step of drift is accepted either side.
 *
 * Replay protection: a verified code returns its time step, the caller stores it, and the
 * next verification passes it as `afterTimeStep` so the same code (or an older one) is
 * refused.
 */
import { Inject, Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import type { AppConfig } from '../../config/configuration';
import type { Clock } from '../clock/clock';
import { APP_CONFIG, CLOCK } from '../tokens';

const PERIOD_SECONDS = 30;
const CODE = /^\d{6}$/;

@Injectable()
export class TotpService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'MFA_ISSUER'>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  generateSecret(): string {
    return generateSecret();
  }

  /** `otpauth://` URI for authenticator apps. `label` is the account name shown in the app. */
  uri(label: string, secret: string): string {
    return generateURI({ issuer: this.config.MFA_ISSUER, label, secret, period: PERIOD_SECONDS });
  }

  /** Returns the accepted time step, or null when the code is wrong or replayed. */
  async verify(secret: string, code: string, afterTimeStep: number | null): Promise<number | null> {
    if (!CODE.test(code)) return null;
    const result = await verify({
      secret,
      token: code,
      period: PERIOD_SECONDS,
      epoch: Math.floor(this.clock.now().getTime() / 1000),
      epochTolerance: PERIOD_SECONDS,
      ...(afterTimeStep !== null ? { afterTimeStep } : {}),
    });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  }
}
