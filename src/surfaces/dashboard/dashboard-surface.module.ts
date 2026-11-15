/**
 * `/dashboard/v1` surface (spec section 4.2): the merchant dashboard, authenticated by a
 * dashboard JWT and scoped to the merchant the session is bound to.
 *
 * Controllers for this surface live in this module tree only. Domain services are
 * shared; controllers are not.
 */
import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../../modules/api-keys/api-keys.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { MerchantsModule } from '../../modules/merchants/merchants.module';
import { DashboardApiKeysController } from './api-keys.controller';
import { DashboardAuthController } from './auth.controller';
import { DashboardMerchantController } from './merchant.controller';
import { DashboardTeamController } from './team.controller';

@Module({
  imports: [AuthModule, MerchantsModule, ApiKeysModule],
  controllers: [
    DashboardAuthController,
    DashboardMerchantController,
    DashboardTeamController,
    DashboardApiKeysController,
  ],
})
export class DashboardSurfaceModule {}
