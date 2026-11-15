/**
 * Request signature check for the public API (spec 6.11), after authentication and rate
 * limiting.
 *
 * A signature is REQUIRED when the key has `signing_required`, and for every route that
 * needs `payouts:write` on a live key. When the signing headers are present on any other
 * request they are verified too: a bad signature is never ignored, so a client cannot be
 * lulled into thinking an unsigned-in-effect request was protected.
 *
 * Checks, in order, each failing with its own code and none revealing which part of the
 * signing string differed:
 *   1. both headers present                        SIGNATURE_REQUIRED
 *   2. the key has a signing secret                SIGNING_SECRET_MISSING
 *   3. timestamp digits-only, within tolerance     SIGNATURE_TIMESTAMP_INVALID (300 s)
 *   4. `v1=<64 hex>` header                         SIGNATURE_INVALID
 *   5. HMAC-SHA256 equal in constant time          SIGNATURE_INVALID
 *   6. not seen before (Redis, fails closed)       SIGNATURE_REPLAYED
 *
 * The replay record is written only after the MAC verifies, so an attacker cannot use
 * forged signatures to burn a victim's legitimate ones.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/configuration';
import { POLICY, type Policy } from '../authz/policy.decorators';
import type { Clock } from '../clock/clock';
import { FieldEncryption } from '../crypto/field-encryption';
import { AppError } from '../errors/app-error';
import { authFailures } from '../telemetry/metrics';
import { APP_CONFIG, CLOCK } from '../tokens';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  parseSignatureHeader,
  parseTimestamp,
  verifySignature,
  withinTolerance,
} from './request-signing';
import { signingSecretContext } from './signing-secret';
import { SignatureReplayStore } from './signature-replay.store';

function singleHeader(request: FastifyRequest, name: string): string | undefined | null {
  const value = request.headers[name];
  if (value === undefined) return undefined;
  // A repeated header is ambiguous, so it is never accepted.
  return typeof value === 'string' ? value : null;
}

@Injectable()
export class RequestSignatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly encryption: FieldEncryption,
    private readonly replays: SignatureReplayStore,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'SIGNATURE_TOLERANCE_SECONDS'>,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = request.principal;
    if (principal?.kind !== 'api_key') return true;
    const policy = this.reflector.getAllAndOverride<Policy | undefined>(POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const livePayout =
      principal.environment === 'live' &&
      policy?.kind === 'permission' &&
      policy.permission === 'payouts:write';
    const timestamp = singleHeader(request, TIMESTAMP_HEADER);
    const signature = singleHeader(request, SIGNATURE_HEADER);
    const present = timestamp !== undefined || signature !== undefined;
    if (!principal.signing.required && !livePayout && !present) return true;

    const fail = (code: ConstructorParameters<typeof AppError>[0], reason: string): never => {
      authFailures.inc({ surface: 'public', reason });
      throw new AppError(code);
    };
    if (!timestamp || !signature) return fail('SIGNATURE_REQUIRED', 'signature_required');
    if (!principal.signing.secretEnc)
      return fail('SIGNING_SECRET_MISSING', 'signing_not_configured');

    const seconds = parseTimestamp(timestamp);
    if (
      seconds === null ||
      !withinTolerance(seconds, this.clock.now(), this.config.SIGNATURE_TOLERANCE_SECONDS)
    ) {
      return fail('SIGNATURE_TIMESTAMP_INVALID', 'signature_timestamp');
    }
    const presented = parseSignatureHeader(signature);
    if (!presented) return fail('SIGNATURE_INVALID', 'signature_invalid');

    const secret = this.encryption.decrypt(
      principal.signing.secretEnc,
      signingSecretContext(principal.apiKeyRef)
    );
    // The request target as sent: path and query string (see request-signing.ts).
    const path = request.raw.url ?? request.url;
    if (!verifySignature(presented, secret, timestamp, request.method, path, request.rawBody)) {
      return fail('SIGNATURE_INVALID', 'signature_invalid');
    }
    if (!(await this.replays.claim(principal.apiKeyId, presented.toString('hex')))) {
      return fail('SIGNATURE_REPLAYED', 'signature_replayed');
    }
    return true;
  }
}
