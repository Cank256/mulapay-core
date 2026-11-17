import { Module } from '@nestjs/common';
import { RedisModule } from '../../common/redis/redis.module';
import { RedisCircuitBreaker } from './circuit-breaker';
import { GatewayOperationsClient } from './gateway-operations.client';
import { GATEWAY_OPERATIONS } from './gateway-operations.port';

/** Binds the gateway operations port to its HTTP adapter. Tests override the token. */
@Module({
  imports: [RedisModule],
  providers: [
    RedisCircuitBreaker,
    { provide: GATEWAY_OPERATIONS, useClass: GatewayOperationsClient },
  ],
  exports: [GATEWAY_OPERATIONS, RedisCircuitBreaker],
})
export class GatewayOperationsModule {}
