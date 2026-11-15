/**
 * Session cookies (spec 8.3).
 *
 * - `mp_refresh`: the refresh token. `HttpOnly; Secure; SameSite=Strict`, path limited to
 *   the surface's auth routes (`/dashboard/v1/auth` or `/admin/v1/auth`).
 * - `mp_csrf`: double-submit CSRF token, same path, readable by the client. Refresh
 *   requires the `X-CSRF-Token` header to equal it. The token is also in the login
 *   response body, because a dashboard on another origin cannot read API cookies.
 */
// Loads the request.cookies / reply.setCookie type augmentation of @fastify/cookie.
import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { safeEqual } from '../../common/crypto/crypto';
import { AppError } from '../../common/errors/app-error';
import type { AuthSurface, TokenBundle } from '../../modules/auth/session.service';

export const REFRESH_COOKIE = 'mp_refresh';
export const CSRF_COOKIE = 'mp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function authCookiePath(surface: AuthSurface): string {
  return surface === 'admin' ? '/admin/v1/auth' : '/dashboard/v1/auth';
}

export function setSessionCookies(reply: FastifyReply, surface: AuthSurface, tokens: TokenBundle) {
  const common = {
    path: authCookiePath(surface),
    secure: true,
    sameSite: 'strict' as const,
    expires: tokens.refreshTokenExpiresAt,
  };
  void reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, { ...common, httpOnly: true });
  void reply.setCookie(CSRF_COOKIE, tokens.csrfToken, { ...common, httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply, surface: AuthSurface) {
  const options = { path: authCookiePath(surface), secure: true, sameSite: 'strict' as const };
  void reply.clearCookie(REFRESH_COOKIE, { ...options, httpOnly: true });
  void reply.clearCookie(CSRF_COOKIE, options);
}

/** The refresh token from the cookie, after the double-submit CSRF check. */
export function readRefreshToken(request: FastifyRequest): string {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  if (!cookieToken || typeof header !== 'string' || !safeEqual(cookieToken, header)) {
    throw new AppError('CSRF_TOKEN_INVALID');
  }
  const refresh = request.cookies[REFRESH_COOKIE];
  if (!refresh) throw new AppError('REFRESH_TOKEN_INVALID');
  return refresh;
}

export function clientMeta(request: FastifyRequest) {
  const userAgent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof userAgent === 'string' ? userAgent : undefined };
}
