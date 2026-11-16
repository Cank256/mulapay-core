import { Module } from '@nestjs/common';
import { GatewayOperationsClient } from './gateway-operations.client';
import { GATEWAY_OPERATIONS } from './gateway-operations.port';

/** Binds the gateway operations port to its HTTP adapter. Tests override the token. */
@Module({
  providers: [{ provide: GATEWAY_OPERATIONS, useClass: GatewayOperationsClient }],
  exports: [GATEWAY_OPERATIONS],
})
export class GatewayOperationsModule {}
