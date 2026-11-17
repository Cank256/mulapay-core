/** Root module of the `api` process: HTTP only, no workers, no pollers (spec 4.1). */
import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE, RouterModule } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import type { Logger } from 'pino';
import type { Clock } from './common/clock/clock';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { AuditModule } from './common/audit/audit.module';
import { AuthCoreModule } from './common/auth/auth-core.module';
import { AuthGuard } from './common/auth/auth.guard';
import { RequestSignatureGuard } from './common/auth/request-signature.guard';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './common/db/database.module';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter';
import { HealthModule } from './common/health/health.module';
import { ResponseEnvelopeInterceptor } from './common/http/envelope.interceptor';
import { QueueModule } from './common/queue/queue.module';
import { RedisModule } from './common/redis/redis.module';
import { TelemetryModule } from './common/telemetry/telemetry.module';
import type { AppConfig } from './config/configuration';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { MaintenanceGuard } from './modules/operations/maintenance.guard';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { OperationsModule } from './modules/operations/operations.module';
import { AuthModule } from './modules/auth/auth.module';
import { SURFACE_MODULES, SURFACE_ROUTES } from './surfaces/surfaces';

export interface AppModuleOptions {
  /** Extra modules, for tests only. */
  readonly extraImports?: ModuleMetadata['imports'];
  /** Replaces the system clock, for tests only. */
  readonly clock?: Clock;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CommonModule.forRoot(config, logger, options.clock),
        DatabaseModule,
        RedisModule,
        QueueModule,
        TelemetryModule.forRoot(config),
        AuditModule,
        AuthCoreModule,
        AuthModule,
        ApiKeysModule,
        LifecycleModule,
        OperationsModule,
        HealthModule,
        ...SURFACE_MODULES,
        RouterModule.register(SURFACE_ROUTES),
        ...(options.extraImports ?? []),
      ],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        // Every route passes the AuthGuard; a route without a policy decorator is refused.
        // The AuthGuard authenticates, rate limits API keys, then authorizes; the signature
        // guard runs after it and only acts on API key requests (spec 8.5, 6.11).
        // Maintenance mode refuses writes before anything else looks at the request (spec 6.14).
        { provide: APP_GUARD, useClass: MaintenanceGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RequestSignatureGuard },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    };
  }
}
