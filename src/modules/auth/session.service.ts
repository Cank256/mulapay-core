/**
 * Sessions and refresh-token rotation (spec section 8.3).
 *
 * - A refresh token is 32 random bytes; only its SHA-256 is stored.
 * - Every refresh retires the presented token and issues a successor in the same family.
 * - Presenting a retired (rotated) token again is reuse: the whole family is revoked, the
 *   event is audited and logged as a security alert, and the request fails.
 * - A family has an absolute lifetime of REFRESH_TOKEN_TTL from login; rotation does not
 *   extend it.
 * - Revocation is written to Postgres (truth) and then to the Redis revoked-sid set, so
 *   outstanding access tokens stop working immediately.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/configuration';
import { AccessTokenService, type AuthMethod } from '../../common/auth/access-token.service';
import { SessionRevocationStore } from '../../common/auth/session-revocation.store';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { randomToken, sha256Hex } from '../../common/crypto/crypto';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { authFailures } from '../../common/telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { RolesRepository } from '../identity/roles.repository';
import {
  SessionsRepository,
  type RevokedReason,
  type SessionRow,
} from '../identity/sessions.repository';
import { UsersRepository, type UserRow } from '../identity/users.repository';
import { PrincipalRepository } from './principal.repository';

export type AuthSurface = 'dashboard' | 'admin';

export interface ClientMeta {
  readonly ip: string;
  readonly userAgent?: string;
}

export interface SessionSubject {
  readonly user: Pick<UserRow, 'id' | 'ref' | 'type' | 'name' | 'email'>;
  readonly surface: AuthSurface;
  readonly merchant: { id: string; ref: string } | null;
  readonly roles: readonly string[];
  readonly amr: readonly AuthMethod[];
  readonly mfa: boolean;
}

export interface TokenBundle {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly csrfToken: string;
  readonly sessionId: string;
}

type RefreshOutcome =
  | { kind: 'ok'; bundle: TokenBundle }
  | { kind: 'reused'; familyId: string }
  | { kind: 'denied'; familyId: string }
  | { kind: 'invalid' };

@Injectable()
export class SessionService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly principals: PrincipalRepository,
    private readonly accessTokens: AccessTokenService,
    private readonly revocations: SessionRevocationStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'REFRESH_TOKEN_TTL'>,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Starts a session family inside the caller's transaction (the login). */
  async start(tx: Transaction, subject: SessionSubject, meta: ClientMeta): Promise<TokenBundle> {
    const now = this.clock.now();
    const familyId = publicId('session', now);
    const expiresAt = new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL * 1000);
    return this.insertToken(tx, subject, familyId, now, expiresAt, meta);
  }

  /** Rotates a refresh token. Throws REFRESH_TOKEN_INVALID for every failure mode. */
  async refresh(
    surface: AuthSurface,
    refreshToken: string,
    meta: ClientMeta
  ): Promise<TokenBundle> {
    const tokenHash = sha256Hex(refreshToken);
    const outcome = await this.unitOfWork.run((tx) => this.rotate(tx, surface, tokenHash, meta));
    if (outcome.kind === 'ok') return outcome.bundle;
    if (outcome.kind === 'reused' || outcome.kind === 'denied') {
      await this.pushRevocation([outcome.familyId]);
    }
    if (outcome.kind === 'reused') {
      authFailures.inc({ surface, reason: 'refresh_token_reused' });
      this.logger.warn(
        { securityAlert: 'refresh_token_reuse', sessionId: outcome.familyId },
        'refresh token reuse detected; session family revoked'
      );
    }
    throw new AppError('REFRESH_TOKEN_INVALID');
  }

  /** Revokes one session family. Returns false if it was not active. */
  async revokeFamily(
    familyId: string,
    reason: RevokedReason,
    action: string,
    merchantId: string | null
  ) {
    const revoked = await this.unitOfWork.run(async (tx) => {
      const count = await this.sessions.revokeFamily(tx, familyId, reason, this.clock.now());
      if (count === 0) return false;
      await this.audit.record(tx, {
        action,
        resourceType: 'session',
        resourceId: familyId,
        merchantId,
        before: { status: 'active' },
        after: { status: 'revoked', reason },
      });
      return true;
    });
    if (revoked) await this.pushRevocation([familyId]);
    return revoked;
  }

  listActive(userId: string, surface: AuthSurface): Promise<SessionRow[]> {
    return this.sessions.listActive(userId, surface, this.clock.now());
  }

  findActive(familyId: string, userId: string): Promise<SessionRow | undefined> {
    return this.sessions.findActiveByFamily(familyId, userId, this.clock.now());
  }

  /** Issues a fresh access token for an existing session (after step-up). */
  issueAccessToken(subject: SessionSubject, familyId: string, authTime: Date) {
    return this.accessTokens.issue({
      aud: subject.surface,
      sub: subject.user.ref,
      type: subject.user.type as 'staff' | 'merchant_user',
      merchantId: subject.merchant?.ref ?? null,
      roles: [...subject.roles],
      sid: familyId,
      mfa: subject.mfa,
      amr: [...subject.amr],
      auth_time: Math.floor(authTime.getTime() / 1000),
    });
  }

  private async rotate(
    tx: Transaction,
    surface: AuthSurface,
    tokenHash: string,
    meta: ClientMeta
  ): Promise<RefreshOutcome> {
    const now = this.clock.now();
    const retired = await this.sessions.retireForRotation(tx, tokenHash, now);
    if (!retired) {
      const known = await this.sessions.findByTokenHash(tokenHash, tx);
      if (!known || known.revokedReason !== 'rotated' || known.surface !== surface)
        return { kind: 'invalid' };
      await this.sessions.revokeFamily(tx, known.familyId, 'reuse_detected', now);
      await this.audit.record(tx, {
        action: 'auth.refresh_token_reused',
        resourceType: 'session',
        resourceId: known.familyId,
        merchantId: known.merchantId,
        after: { status: 'revoked', reason: 'reuse_detected' },
        outcome: 'denied',
        actor: { type: 'user', id: null, label: null },
      });
      return { kind: 'reused', familyId: known.familyId };
    }
    if (retired.surface !== surface) return { kind: 'invalid' };
    const subject = await this.loadSubject(tx, retired);
    if (!subject) {
      await this.sessions.revokeFamily(tx, retired.familyId, 'access_removed', now);
      return { kind: 'denied', familyId: retired.familyId };
    }
    const bundle = await this.insertToken(
      tx,
      subject,
      retired.familyId,
      retired.authTime,
      retired.expiresAt,
      meta
    );
    await this.audit.record(tx, {
      action: 'auth.session_refreshed',
      resourceType: 'session',
      resourceId: retired.familyId,
      merchantId: retired.merchantId,
      actor: { type: 'user', id: subject.user.ref, label: subject.user.name },
    });
    return { kind: 'ok', bundle };
  }

  /** Who the session belongs to now; null if the user or their access is gone. */
  private async loadSubject(tx: Transaction, row: SessionRow): Promise<SessionSubject | null> {
    const base = {
      surface: row.surface as AuthSurface,
      amr: row.amr as AuthMethod[],
      mfa: row.mfa,
    };
    if (row.surface === 'admin') {
      const user = await this.users.findById(row.userId, tx);
      if (user?.type !== 'staff' || user.status !== 'active' || !user.mfaEnabled) return null;
      return { ...base, user, merchant: null, roles: await this.roles.staffRoles(user.id, tx) };
    }
    if (!row.merchantId) return null;
    const membership = await this.principals.byIds(row.userId, row.merchantId, tx);
    if (!membership || membership.userStatus !== 'active') return null;
    return {
      ...base,
      user: {
        id: membership.userId,
        ref: membership.userRef,
        type: membership.userType,
        name: membership.name,
        email: membership.email,
      },
      merchant: { id: membership.merchantId, ref: membership.merchantRef },
      roles: [membership.role],
    };
  }

  private async insertToken(
    tx: Transaction,
    subject: SessionSubject,
    familyId: string,
    authTime: Date,
    expiresAt: Date,
    meta: ClientMeta
  ): Promise<TokenBundle> {
    const now = this.clock.now();
    const refreshToken = randomToken(32);
    await this.sessions.insert(tx, {
      id: uuidv7(now),
      familyId,
      userId: subject.user.id,
      merchantId: subject.merchant?.id ?? null,
      surface: subject.surface,
      refreshTokenHash: sha256Hex(refreshToken),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      amr: [...subject.amr],
      mfa: subject.mfa,
      authTime,
      expiresAt,
    });
    const access = this.issueAccessToken(subject, familyId, authTime);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
      csrfToken: randomToken(32),
      sessionId: familyId,
    };
  }

  private async pushRevocation(familyIds: string[]): Promise<void> {
    try {
      await this.revocations.revoke(familyIds);
    } catch (error) {
      // Postgres already holds the revocation; refresh is refused. Outstanding access
      // tokens stay valid until they expire (at most ACCESS_TOKEN_TTL).
      this.logger.error(
        { err: toLoggableError(error) },
        'could not publish session revocation to redis'
      );
    }
  }
}
