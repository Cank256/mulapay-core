/**
 * Password reset (spec 7.2): request a reset link, then apply a new password.
 *
 * Invariants:
 *  - Requesting for an unknown email returns the same `ok` shape as a known one, so this
 *    endpoint cannot enumerate registered addresses.
 *  - Any previous unused `password_reset` tokens for the user are invalidated before a new
 *    one is issued; at most one active token exists per user at any time.
 *  - The raw token (32 random bytes, URL-safe base64) is returned to the caller once and
 *    never stored; only its SHA-256 is kept in the database.
 *  - Applying the reset consumes the token atomically. A concurrent call finds the token
 *    already used and receives `EMAIL_TOKEN_INVALID`.
 *  - Every open session is revoked on a successful reset, requiring the user to log in again.
 *  - Both request and apply are audited.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { eq } from 'drizzle-orm';
import { PasswordHasher } from '../../common/auth/password-hasher';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { randomToken, sha256Hex } from '../../common/crypto/crypto';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { users } from '../../db/schema';
import { UsersRepository } from '../identity/users.repository';
import { SessionsRepository } from '../identity/sessions.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailTokensRepository } from './email-tokens.repository';

/** Password-reset token lifetime: 1 hour. */
const RESET_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly sessionsRepo: SessionsRepository,
    private readonly emailTokens: EmailTokensRepository,
    private readonly passwords: PasswordHasher,
    private readonly notifications: NotificationsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /**
   * Issues a password-reset token and delivers it by email.
   * Always returns `{ ok: true }` — unknown addresses are silently ignored.
   */
  async request(email: string): Promise<{ ok: true }> {
    const now = this.clock.now();
    const user = await this.usersRepo.findByEmail(email);

    if (!user || user.status !== 'active' || user.type !== 'merchant_user') {
      this.logger.info({ email }, 'password reset requested for unknown or ineligible account');
      return { ok: true };
    }

    const rawToken = randomToken(32);
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(now.getTime() + RESET_TTL_MS);

    await this.unitOfWork.run(async (tx) => {
      await this.emailTokens.revokeAllForUser(tx, user.id, 'password_reset', now);
      await this.emailTokens.insert(tx, {
        id: uuidv7(now),
        userId: user.id,
        kind: 'password_reset',
        tokenHash,
        expiresAt,
      });
      await this.audit.record(tx, {
        action: 'auth.password_reset_requested',
        resourceType: 'user',
        resourceId: user.ref,
        actor: { type: 'user', id: user.ref, label: user.name },
      });
    });

    // Deliver outside the transaction; a delivery failure does not invalidate the stored token.
    await this.notifications.notifyStandalone({
      templateCode: 'auth.password_reset',
      audience: { kind: 'user', userId: user.id },
      resourceKey: `password_reset:${user.id}`,
      sourceKey: `password_reset:${tokenHash}`,
      variables: { reset_token: rawToken, expires_minutes: String(RESET_TTL_MS / 60_000) },
    });

    return { ok: true };
  }

  /**
   * Validates the token and applies the new password.
   * Revokes every active session so the user must log in again after a reset.
   */
  async reset(token: string, newPassword: string): Promise<{ ok: true }> {
    const now = this.clock.now();
    const tokenHash = sha256Hex(token);
    const tokenRow = await this.emailTokens.findValid(tokenHash, 'password_reset', now);
    if (!tokenRow) throw new AppError('EMAIL_TOKEN_INVALID');

    const user = await this.usersRepo.findById(tokenRow.userId);
    if (!user || user.status !== 'active') throw new AppError('EMAIL_TOKEN_INVALID');

    const passwordHash = await this.passwords.hash(newPassword);

    await this.unitOfWork.run(async (tx) => {
      const consumed = await this.emailTokens.consume(tx, tokenRow.id, now);
      if (!consumed) throw new AppError('EMAIL_TOKEN_INVALID');

      await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));

      // Revoke all active sessions so a stolen password cannot be used after a reset.
      const activeSessions = await this.sessionsRepo.listActive(user.id, 'dashboard', now);
      for (const session of activeSessions) {
        await this.sessionsRepo.revokeFamily(tx, session.familyId, 'logout', now);
      }

      await this.audit.record(tx, {
        action: 'auth.password_reset_applied',
        resourceType: 'user',
        resourceId: user.ref,
        actor: { type: 'user', id: user.ref, label: user.name },
      });
    });

    return { ok: true };
  }
}
