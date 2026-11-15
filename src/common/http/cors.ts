/**
 * CORS per surface (spec section 11). The public `/v1` API is server-to-server and allows
 * no browser origins. The dashboard and admin surfaces each allow only their own
 * configured origins. Everything else gets no CORS headers.
 */
import type { FastifyCorsOptions, FastifyCorsOptionsDelegateCallback } from '@fastify/cors';
import type { AppConfig } from '../../config/configuration';
import { resolveSurface } from './surface';

const DENY: FastifyCorsOptions = { origin: false };

export function corsOptionsFor(
  url: string,
  config: Pick<AppConfig, 'CORS_DASHBOARD_ORIGINS' | 'CORS_ADMIN_ORIGINS'>
): FastifyCorsOptions {
  const surface = resolveSurface(url);
  const origins =
    surface === 'dashboard'
      ? config.CORS_DASHBOARD_ORIGINS
      : surface === 'admin'
        ? config.CORS_ADMIN_ORIGINS
        : [];
  if (origins.length === 0) return DENY;
  return {
    origin: [...origins],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'X-CSRF-Token',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  };
}

export function corsDelegator(
  config: Pick<AppConfig, 'CORS_DASHBOARD_ORIGINS' | 'CORS_ADMIN_ORIGINS'>
): () => FastifyCorsOptionsDelegateCallback {
  return () => (request, callback) => callback(null, corsOptionsFor(request.url ?? '/', config));
}
