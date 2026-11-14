import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '../../config/configuration';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/** API-process metrics. Tracing shutdown lives in CommonModule so every process gets it. */
@Module({})
export class TelemetryModule {
  /** The metrics route exists only when METRICS_TOKEN is configured. */
  static forRoot(config: Pick<AppConfig, 'METRICS_TOKEN'>): DynamicModule {
    return {
      module: TelemetryModule,
      controllers: config.METRICS_TOKEN ? [MetricsController] : [],
      providers: [MetricsService],
      exports: [MetricsService],
    };
  }
}
