/**
 * The global authentication and authorization guard (spec sections 4.2, 8.3, 8.4).
 *
 * 1. Fail closed: a route without a policy decorator is refused.
 * 2. Authenticate by the surface of the matched route template (never the raw URL):
 *    `/v1` API key, `/merchant/v1` dashboard JWT, `/admin/v1` admin JWT with MFA.
 *    A dashboard token is never accepted on admin routes and vice versa (JWT `aud`).
 * 3. Authorize with the actor's CASL ability, then step-up, then the merchant status
 *    rule that a closed merchant may only read (spec 6.10).
 *
 * Denials of state-changing requests by an authenticated actor are audited here, because
 * guards run before the audit interceptor.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/configuration';
import { AUDITED, type AuditedMetadata } from '../audit/audited.decorator';
import { routeResourceId } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { abilityAllows } from '../authz/ability';
import { parsePermission } from '../authz/permissions';
import { POLICY, STEP_UP, type Policy } from '../authz/policy.decorators';
import type { Clock } from '../clock/clock';
import { requestContext } from '../context/request-context';
import { AppError } from '../errors/app-error';
import type { ErrorCode } from '../errors/catalogue';
import { resolveSurface, type Surface } from '../http/surface';
import { toLoggableError } from '../logging/redaction';
import { AuthFailureLimiter } from '../ratelimit/auth-failure-limiter';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { authFailures } from '../telemetry/metrics';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from '../tokens';
import { AccessTokenService, type TokenAudience } from './access-token.service';
import {
  API_KEY_AUTHENTICATOR,
  PRINCIPAL_RESOLVER,
  type ApiKeyAuthenticator,
  type Principal,
  type PrincipalResolver,
} from './principal';
import { SessionRevocationStore } from './session-revocation.store';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]{1,2048})$/.exec(header);
  return match?.[1] ?? null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly revocations: SessionRevocationStore,
    @Inject(PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
    @Inject(API_KEY_AUTHENTICATOR) private readonly apiKeys: ApiKeyAuthenticator,
    private readonly audit: AuditService,
    private readonly authFailureLimiter: AuthFailureLimiter,
    private readonly rateLimit: RateLimitGuard,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'STEP_UP_WINDOW_SECONDS'>,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const policy = this.reflector.getAllAndOverride<Policy | undefined>(POLICY, targets);
    if (!policy) {
      this.logger.error({ route: request.routeOptions.url }, 'route has no policy; refusing');
      throw new AppError('FORBIDDEN');
    }
    if (policy.kind === 'public') return true;

    const surface = resolveSurface(request.routeOptions.url ?? '');
    const principal = await this.authenticate(surface, request);
    if (!principal) {
      authFailures.inc({ surface, reason: 'unauthenticated' });
      throw new AppError('UNAUTHORIZED');
    }
    request.principal = principal;
    this.bindContext(principal);
    // Every authenticated API key request is metered, including ones about to be refused for
    // a missing scope, so refusals cannot be used as free probing (spec 8.5).
    if (principal.kind === 'api_key') await this.rateLimit.canActivate(context);

    if (policy.kind === 'permission' && !abilityAllows(principal.ability, policy.permission)) {
      return this.deny(context, request, surface, 'FORBIDDEN', 'forbidden');
    }
    if (
      this.reflector.getAllAndOverride<boolean>(STEP_UP, targets) &&
      !this.hasFreshAuth(principal)
    ) {
      return this.deny(context, request, surface, 'STEP_UP_REQUIRED', 'step_up_required');
    }
    if (
      policy.kind === 'permission' &&
      parsePermission(policy.permission).action !== 'read' &&
      principal.kind !== 'staff' &&
      principal.merchant.status === 'closed'
    ) {
      return this.deny(context, request, surface, 'MERCHANT_CLOSED', 'merchant_closed');
    }
    return true;
  }

  private async authenticate(surface: Surface, request: FastifyRequest): Promise<Principal | null> {
    const token = bearerToken(request);
    if (surface === 'public') return this.authenticateApiKey(token, request);
    if (!token) return null;
    if (surface !== 'dashboard' && surface !== 'admin') return null;
    const audience: TokenAudience = surface;
    const claims = this.accessTokens.verify(token, audience);
    if (!claims) return null;
    if (audience === 'admin' && !claims.mfa) return null;
    if (await this.revocations.isRevoked(claims.sid)) return null;
    return this.principals.resolve(claims);
  }

  /**
   * API key authentication with the failure limiter (spec 8.5): a client that has failed
   * too often is answered 429 before its credential is examined, and every failure counts.
   */
  private async authenticateApiKey(
    token: string | null,
    request: FastifyRequest
  ): Promise<Principal | null> {
    await this.authFailureLimiter.assertNotBlocked(request.ip);
    const principal = token ? await this.apiKeys.authenticate(token, request.ip) : null;
    if (!principal) await this.authFailureLimiter.recordFailure(request.ip);
    return principal;
  }
  /** Step-up (spec 8.3): a password or MFA assertion within STEP_UP_WINDOW_SECONDS. */
  private hasFreshAuth(principal: Principal): boolean {
    if (principal.kind === 'api_key') return false;
    const ageSeconds = (this.clock.now().getTime() - principal.authTime.getTime()) / 1000;
    return principal.amr.length > 0 && ageSeconds <= this.config.STEP_UP_WINDOW_SECONDS;
  }

  private bindContext(principal: Principal): void {
    const ctx = requestContext.get();
    if (!ctx) return;
    if (principal.kind === 'api_key') {
      ctx.actorType = 'api_key';
      ctx.actorId = principal.apiKeyRef;
      ctx.actorLabel = principal.name;
      ctx.merchantId = principal.merchant.ref;
      return;
    }
    ctx.actorType = 'user';
    ctx.actorId = principal.userRef;
    ctx.actorLabel = principal.name;
    if (principal.kind === 'merchant_user') ctx.merchantId = principal.merchant.ref;
  }

  private async deny(
    context: ExecutionContext,
    request: FastifyRequest,
    surface: Surface,
    code: ErrorCode,
    reason: string
  ): Promise<never> {
    authFailures.inc({ surface, reason });
    const meta = this.reflector.get<AuditedMetadata | undefined>(AUDITED, context.getHandler());
    if (WRITE_METHODS.has(request.method)) {
      const principal = request.principal;
      try {
        await this.audit.recordStandalone({
          action: meta?.action ?? `${request.method} ${request.routeOptions.url ?? ''}`,
          resourceType: meta?.resourceType ?? 'route',
          resourceId: routeResourceId(request),
          merchantId: principal && principal.kind !== 'staff' ? principal.merchant.id : null,
          outcome: 'denied',
        });
      } catch (error) {
        this.logger.error(
          { err: toLoggableError(error) },
          'audit row for a denial could not be written'
        );
      }
    }
    throw new AppError(code);
  }
}
