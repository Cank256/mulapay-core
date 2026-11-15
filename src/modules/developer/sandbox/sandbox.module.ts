import { Module } from '@nestjs/common';
import { PaymentsModule } from '../../payments/payments.module';
import { SandboxPaymentHandler } from './sandbox.handler';
import { SandboxProcessor } from './sandbox.processor';
import { SandboxService } from './sandbox.service';

/** The test-key sandbox simulator (spec 6.11). Never imports the gateway integration. */
@Module({
  imports: [PaymentsModule],
  providers: [SandboxService, SandboxPaymentHandler, SandboxProcessor],
  exports: [SandboxService, SandboxPaymentHandler, SandboxProcessor],
})
export class SandboxModule {}
