/** Response shapes for login, MFA, refresh and session routes on both user surfaces. */
import { z } from 'zod';
import type { SessionRow } from '../../modules/identity/sessions.repository';
import type { LoginResult } from '../../modules/auth/auth.service';
import type { SessionSubject, TokenBundle } from '../../modules/auth/session.service';

export const tokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  csrfToken: z.string(),
  sessionId: z.string(),
});

export const authenticatedSchema = tokensSchema.extend({
  status: z.literal('authenticated'),
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  merchant: z.object({ id: z.string(), role: z.string() }).nullable(),
  roles: z.array(z.string()),
});

export const mfaRequiredSchema = z.object({
  status: z.literal('mfa_required'),
  mfaToken: z.string(),
  expiresAt: z.iso.datetime(),
});

export const loginResponseSchema = z.union([authenticatedSchema, mfaRequiredSchema]);

export function tokensView(tokens: TokenBundle) {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    csrfToken: tokens.csrfToken,
    sessionId: tokens.sessionId,
  };
}

export function authenticatedView(tokens: TokenBundle, subject: SessionSubject) {
  return {
    status: 'authenticated' as const,
    ...tokensView(tokens),
    user: { id: subject.user.ref, email: subject.user.email, name: subject.user.name },
    merchant: subject.merchant ? { id: subject.merchant.ref, role: subject.roles[0] ?? '' } : null,
    roles: [...subject.roles],
  };
}

export function loginView(result: LoginResult) {
  return result.status === 'mfa_required'
    ? {
        status: result.status,
        mfaToken: result.mfaToken,
        expiresAt: result.expiresAt.toISOString(),
      }
    : authenticatedView(result.tokens, result.subject);
}

export const accessTokenSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
});

export const sessionSchema = z.object({
  id: z.string(),
  current: z.boolean(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  mfa: z.boolean(),
  authenticatedAt: z.iso.datetime(),
  lastRefreshedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export function sessionView(row: SessionRow, currentSessionId: string) {
  return {
    id: row.familyId,
    current: row.familyId === currentSessionId,
    ip: row.ip,
    userAgent: row.userAgent,
    mfa: row.mfa,
    authenticatedAt: row.authTime.toISOString(),
    lastRefreshedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export const okSchema = z.object({ ok: z.literal(true) });
