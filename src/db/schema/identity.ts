/**
 * Users and sessions (spec section 5.2, identity and merchants).
 *
 * One `sessions` row per refresh token. Rotation revokes the presented row
 * (`revoked_reason = 'rotated'`) and inserts its successor with the same `family_id`.
 * Presenting a rotated token again is reuse and revokes the whole family (spec 8.3).
 * `family_id` is the public session id (`ses_...`) and the JWT `sid` claim.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { citext, createdAt, timestamptz, updatedAt } from './columns';
import { core } from './core';
import { merchants } from './merchants';

export const users = core.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    ref: text('ref').notNull(),
    type: text('type').notNull(),
    email: citext('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    /** AES-256-GCM (FieldEncryption), bound to the user id. Pending until mfa_enabled. */
    mfaSecretEnc: text('mfa_secret_enc'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** Last accepted TOTP time step; codes at or before it are replays. */
    mfaLastUsedStep: bigint('mfa_last_used_step', { mode: 'number' }),
    lastLoginAt: timestamptz('last_login_at'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_ref_key').on(t.ref),
    uniqueIndex('users_email_key').on(t.email),
    check('users_type_check', sql`${t.type} in ('staff', 'merchant_user')`),
    check('users_status_check', sql`${t.status} in ('active', 'disabled')`),
    check('users_failed_login_count_check', sql`${t.failedLoginCount} >= 0`),
    check(
      'users_mfa_enabled_secret_check',
      sql`not ${t.mfaEnabled} or ${t.mfaSecretEnc} is not null`
    ),
  ]
);

export const sessions = core.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    familyId: text('family_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Merchant the dashboard session is bound to; null for staff sessions. */
    merchantId: uuid('merchant_id').references(() => merchants.id),
    surface: text('surface').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    device: text('device'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Authentication methods asserted at login or step-up (`pwd`, `otp`). */
    amr: text('amr').array().notNull(),
    mfa: boolean('mfa').notNull(),
    /** Time of the last password or MFA assertion; drives step-up (spec 8.3). */
    authTime: timestamptz('auth_time').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sessions_refresh_token_hash_key').on(t.refreshTokenHash),
    index('sessions_family_idx').on(t.familyId),
    index('sessions_user_active_idx')
      .on(t.userId, t.expiresAt)
      .where(sql`${t.revokedAt} is null`),
    check('sessions_surface_check', sql`${t.surface} in ('dashboard', 'admin')`),
    check(
      'sessions_revoked_reason_check',
      sql`${t.revokedReason} is null or ${t.revokedReason} in ('rotated', 'logout', 'revoked_by_user', 'reuse_detected', 'user_disabled', 'access_removed')`
    ),
  ]
);
