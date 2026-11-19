/**
 * Email address verification (spec 7.2): send a verification link, then confirm it.
 *
 * Invariants:
 *  - `users.email_verified` is `true` once the user confirms the link.
 *  - Calling send-verification while already verified returns `EMAIL_ALREADY_VERIFIED`.
 *  - Previous unused verification tokens are revoked before a new one is issued; at most
 *    one active token exists per user at any time.
 *  - The raw token is returned to the caller once; only its SHA-256 is stored.
 *  - Consuming the token is atomic; a duplicate call finds it used and receives
 *    `EMAIL_TOKEN_INVALID`.
 *  - Both send and confirm are audited.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { randomToken, sha256Hex } from '../../common/crypto/crypto';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { users } from '../../db/schema';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { UsersRepository } from '../identity/users.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailTokensRepository } from './email-tokens.repository';

/** Email-verification token lifetime: 24 hours. */
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly emailTokens: EmailTokensRepository,
    private readonly notifications: NotificationsService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /**
   * Sends or re-sends the verification email to the authenticated user.
   * Throws `EMAIL_ALREADY_VERIFIED` when the email is already confirmed.
   */
  async send(principal: MerchantUserPrincipal): Promise<{ ok: true }> {
    const now = this.clock.now();
    const user = await this.usersRepo.findById(principal.userId);
    if (!user || user.status !== 'active') throw new AppError('UNAUTHORIZED');
    if (user.emailVerified) throw new AppError('EMAIL_ALREADY_VERIFIED');

    const rawToken = randomToken(32);
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(now.getTime() + VERIFY_TTL_MS);

    await this.unitOfWork.run(async (tx) => {
      await this.emailTokens.revokeAllForUser(tx, user.id, 'email_verification', now);
      await this.emailTokens.insert(tx, {
        id: uuidv7(now),
        userId: user.id,
        kind: 'email_verification',
        tokenHash,
        expiresAt,
      });
      await this.audit.record(tx, {
        action: 'auth.verify_email_sent',
        resourceType: 'user',
        resourceId: user.ref,
        actor: { type: 'user', id: user.ref, label: user.name },
      });
    });

    // Deliver outside the transaction; a delivery failure does not invalidate the stored token.
    await this.notifications.notifyStandalone({
      templateCode: 'auth.verify_email',
      audience: { kind: 'user', userId: user.id },
      resourceKey: `verify_email:${user.id}`,
      sourceKey: `verify_email:${tokenHash}`,
      variables: { verify_token: rawToken, expires_hours: String(VERIFY_TTL_MS / 3_600_000) },
    });

    return { ok: true };
  }

  /**
   * Confirms the token and marks `users.email_verified = true`.
   */
  async confirm(token: string): Promise<{ ok: true }> {
    const now = this.clock.now();
    const tokenHash = sha256Hex(token);
    const tokenRow = await this.emailTokens.findValid(tokenHash, 'email_verification', now);
    if (!tokenRow) throw new AppError('EMAIL_TOKEN_INVALID');

    const user = await this.usersRepo.findById(tokenRow.userId);
    if (!user || user.status !== 'active') throw new AppError('EMAIL_TOKEN_INVALID');

    if (user.emailVerified) {
      await this.unitOfWork.run((tx) => this.emailTokens.consume(tx, tokenRow.id, now));
      throw new AppError('EMAIL_ALREADY_VERIFIED');
    }

    await this.unitOfWork.run(async (tx) => {
      const consumed = await this.emailTokens.consume(tx, tokenRow.id, now);
      if (!consumed) throw new AppError('EMAIL_TOKEN_INVALID');

      await tx.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));

      await this.audit.record(tx, {
        action: 'auth.email_verified',
        resourceType: 'user',
        resourceId: user.ref,
        actor: { type: 'user', id: user.ref, label: user.name },
      });
    });

    return { ok: true };
  }
}
