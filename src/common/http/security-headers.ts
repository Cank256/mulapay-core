/**
 * Security headers (spec section 11): helmet with a deny-all CSP for API responses,
 * `X-Frame-Options: DENY`, `nosniff`, and no `Server` header (Fastify sends none).
 * The docs pages get their own CSP, set by the docs routes.
 */
import type { FastifyHelmetOptions } from '@fastify/helmet';

export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const helmetOptions: FastifyHelmetOptions = {
  global: true,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false,
};

/** CSP for the Scalar docs pages: scripts and styles only from self with the page nonce. */
export function docsCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
