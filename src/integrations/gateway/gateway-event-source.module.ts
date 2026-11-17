/**
 * Provides the gateway event source selected by `GATEWAY_EVENT_SOURCE` config: 'database'
 * (reads `public.operation_events` through the `ro` pool) or 'http' (calls `GET /api/v1/events`).
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../common/db/database.module';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { DatabaseGatewayEventSource } from './gateway-event-source.database';
import { HttpGatewayEventSource } from './gateway-event-source.http';
import { GATEWAY_EVENT_SOURCE } from './gateway-event-source.port';

@Module({
  imports: [DatabaseModule],
  providers: [
    DatabaseGatewayEventSource,
    HttpGatewayEventSource,
    {
      provide: GATEWAY_EVENT_SOURCE,
      useFactory: (
        config: AppConfig,
        database: DatabaseGatewayEventSource,
        http: HttpGatewayEventSource
      ) => {
        return config.GATEWAY_EVENT_SOURCE === 'database' ? database : http;
      },
      inject: [APP_CONFIG, DatabaseGatewayEventSource, HttpGatewayEventSource],
    },
  ],
  exports: [GATEWAY_EVENT_SOURCE],
})
export class GatewayEventSourceModule {}
