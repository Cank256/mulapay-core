import { Module } from '@nestjs/common';
import { RedisModule } from '../../common/redis/redis.module';
import { DatabaseModule } from '../../common/db/database.module';
import { RedisCircuitBreaker } from './circuit-breaker';
import { GatewayOperationsClient } from './gateway-operations.client';
import { GATEWAY_OPERATIONS } from './gateway-operations.port';
import { GatewayRequestRecorder } from './gateway-request.recorder';

/** Binds the gateway operations port to its HTTP adapter. Tests override the token. */
@Module({
  imports: [RedisModule, DatabaseModule],
  providers: [
    RedisCircuitBreaker,
    GatewayRequestRecorder,
    { provide: GATEWAY_OPERATIONS, useClass: GatewayOperationsClient },
  ],
  exports: [GATEWAY_OPERATIONS, RedisCircuitBreaker],
})
export class GatewayOperationsModule {}
