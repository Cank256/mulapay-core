import { Module } from '@nestjs/common';
import { GatewayHealthClient } from '../../integrations/gateway/gateway-health.client';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService, GatewayHealthClient],
})
export class HealthModule {}
