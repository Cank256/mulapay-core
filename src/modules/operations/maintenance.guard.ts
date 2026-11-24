/**
 * Refuses writes with `503 MAINTENANCE_MODE` and `Retry-After` while maintenance mode is on
 * (spec 6.14). It runs before the AuthGuard, so a refused request is not authenticated, rate
 * limited or audited as a denial: there is nothing the caller did wrong.
 *
 * Reads (GET, HEAD, OPTIONS) always pass. So do the routes staff need to get in and turn it
 * off, and the sign-in routes that only create or end a session and change no business state.
 * Background work in the worker and consumer is not HTTP and is not affected.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors/app-error';
import { maintenanceRejections } from '../../common/telemetry/metrics';
import { MaintenanceService } from './maintenance.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `METHOD route-template` pairs that stay open. */
export const MAINTENANCE_ALLOWED_WRITES: ReadonlySet<string> = new Set([
  'POST /admin/v1/ops/maintenance-mode',
  'POST /admin/v1/auth/login',
  'POST /admin/v1/auth/mfa/verify',
  'POST /admin/v1/auth/refresh',
  'POST /admin/v1/auth/logout',
  'POST /admin/v1/auth/step-up',
  'POST /merchant/v1/auth/login',
  'POST /merchant/v1/auth/mfa/verify',
  'POST /merchant/v1/auth/refresh',
  'POST /merchant/v1/auth/logout',
]);

@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private readonly maintenance: MaintenanceService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (READ_METHODS.has(request.method)) return true;
    const route = request.routeOptions?.url ?? '';
    if (MAINTENANCE_ALLOWED_WRITES.has(`${request.method} ${route}`)) return true;
    const state = await this.maintenance.current();
    if (!state.enabled) return true;
    maintenanceRejections.inc();
    throw new AppError('MAINTENANCE_MODE', { retryAfterSeconds: state.retryAfterSeconds });
  }
}
