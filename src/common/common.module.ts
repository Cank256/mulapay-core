/**
 * Process-wide singletons shared by the api, worker and consumer processes: validated
 * configuration, the root logger, the clock, and tracing shutdown.
 */
import {
  Global,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/configuration';
import { SystemClock, type Clock } from './clock/clock';
import { shutdownTracing } from './telemetry/tracing';
import { APP_CONFIG, CLOCK, ROOT_LOGGER } from './tokens';

@Injectable()
class TracingLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTracing();
  }
}

@Global()
@Module({})
export class CommonModule {
  /** `clock` replaces the system clock; tests pass a FixedClock. */
  static forRoot(config: AppConfig, logger: Logger, clock?: Clock): DynamicModule {
    return {
      module: CommonModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ROOT_LOGGER, useValue: logger },
        clock ? { provide: CLOCK, useValue: clock } : { provide: CLOCK, useClass: SystemClock },
        TracingLifecycle,
      ],
      exports: [APP_CONFIG, ROOT_LOGGER, CLOCK],
    };
  }
}
