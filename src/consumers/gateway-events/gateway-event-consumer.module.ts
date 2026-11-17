/**
 * Gateway event consumer module: wires the consumer service with its dependencies (event source,
 * unit of work, clock). The consumer starts automatically on module init.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../common/db/database.module';
import { GatewayEventSourceModule } from '../../integrations/gateway/gateway-event-source.module';
import { GatewayEventConsumer } from './gateway-event.consumer';

@Module({
  imports: [GatewayEventSourceModule, DatabaseModule],
  providers: [GatewayEventConsumer],
  exports: [GatewayEventConsumer],
})
export class GatewayEventConsumerModule {}
