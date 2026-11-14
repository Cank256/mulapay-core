/**
 * API surfaces (spec section 4.2). Each surface has its own module tree, guards and
 * OpenAPI document; `infra` covers health, metrics and the status feed.
 */
export type Surface = 'public' | 'dashboard' | 'admin' | 'infra' | 'docs' | 'unknown';

const INFRA_PATHS = new Set(['/v1/health', '/v1/health/ready', '/v1/status', '/metrics']);

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Classifies a request URL by surface. Query strings are ignored. */
export function resolveSurface(url: string): Surface {
  const path = url.split('?')[0] ?? url;
  if (INFRA_PATHS.has(path)) return 'infra';
  if (matchesPrefix(path, '/dashboard/v1')) return 'dashboard';
  if (matchesPrefix(path, '/admin/v1')) return 'admin';
  if (matchesPrefix(path, '/docs')) return 'docs';
  if (matchesPrefix(path, '/v1')) return 'public';
  return 'unknown';
}
