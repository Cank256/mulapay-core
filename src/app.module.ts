/** Root module of the `api` process: HTTP only, no workers, no pollers (spec 4.1). */
import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, RouterModule } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import type { Logger } from 'pino';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './common/db/database.module';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter';
import { HealthModule } from './common/health/health.module';
import { ResponseEnvelopeInterceptor } from './common/http/envelope.interceptor';
import { QueueModule } from './common/queue/queue.module';
import { RedisModule } from './common/redis/redis.module';
import { TelemetryModule } from './common/telemetry/telemetry.module';
import type { AppConfig } from './config/configuration';
import { SURFACE_MODULES, SURFACE_ROUTES } from './surfaces/surfaces';

export interface AppModuleOptions {
  /** Extra modules, for tests only. */
  readonly extraImports?: ModuleMetadata['imports'];
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: Logger, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CommonModule.forRoot(config, logger),
        DatabaseModule,
        RedisModule,
        QueueModule,
        TelemetryModule.forRoot(config),
        HealthModule,
        ...SURFACE_MODULES,
        RouterModule.register(SURFACE_ROUTES),
        ...(options.extraImports ?? []),
      ],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    };
  }
}
