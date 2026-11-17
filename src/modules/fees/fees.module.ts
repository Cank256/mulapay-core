import { Module } from '@nestjs/common';
import { FeeCalculatorService } from './fee-calculator.service';
import { MerchantPricingRepository } from './merchant-pricing.repository';

/**
 * Fee calculation module (Phase 4).
 *
 * Provides fee calculation services for payments, payouts, and refunds.
 * All fee math uses bigint minor units. Fee calculation is idempotent.
 */
@Module({
  providers: [FeeCalculatorService, MerchantPricingRepository],
  exports: [FeeCalculatorService, MerchantPricingRepository],
})
export class FeesModule {}
