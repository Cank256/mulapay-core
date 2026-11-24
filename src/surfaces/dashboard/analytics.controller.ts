/**
 * `/merchant/v1/analytics/*` (spec 7.2, 9.2 rule 4): the dashboard's tiles and charts, read from
 * `daily_merchant_rollups` only. The merchant comes from the session and the environment from
 * the request (default `live`).
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  channelsAnalyticsSchema,
  overviewAnalyticsSchema,
  successRateAnalyticsSchema,
  toChannelsAnalytics,
  toOverviewAnalytics,
  toVolumeAnalytics,
  volumeAnalyticsSchema,
} from '../../modules/rollups/rollups.views';
import { RollupsService } from '../../modules/rollups/rollups.service';
import { analyticsQuerySchema } from '../shared/support.schemas';

class QueryDto extends createZodDto(analyticsQuerySchema) {}

@ApiTags('Analytics')
@Controller('analytics')
export class DashboardAnalyticsController {
  constructor(private readonly rollups: RollupsService) {}

  @Get('overview')
  @RequirePermission('analytics:read')
  @ApiOperation({
    summary: 'Totals per currency for a window (default the last 30 days)',
    description:
      'Daily figures are recomputed every 15 minutes, so the newest numbers can be up to that old.',
  })
  @ApiEnvelopedResponses({ 200: overviewAnalyticsSchema })
  async overview(@Query() q: QueryDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...query } = q;
    return toOverviewAnalytics(
      await this.rollups.overview(scopeOfMerchantUser(user, environment ?? 'live'), query)
    );
  }

  @Get('volume')
  @RequirePermission('analytics:read')
  @ApiOperation({ summary: 'Daily payment, refund, payout and fee volume' })
  @ApiEnvelopedResponses({ 200: volumeAnalyticsSchema })
  async volume(@Query() q: QueryDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...query } = q;
    return toVolumeAnalytics(
      await this.rollups.volume(scopeOfMerchantUser(user, environment ?? 'live'), query)
    );
  }

  @Get('success-rate')
  @RequirePermission('analytics:read')
  @ApiOperation({ summary: 'Daily payment success rate' })
  @ApiEnvelopedResponses({ 200: successRateAnalyticsSchema })
  async successRate(@Query() q: QueryDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...query } = q;
    return this.rollups.successRate(scopeOfMerchantUser(user, environment ?? 'live'), query);
  }

  @Get('channels')
  @RequirePermission('analytics:read')
  @ApiOperation({ summary: 'Volume and success rate by channel and provider' })
  @ApiEnvelopedResponses({ 200: channelsAnalyticsSchema })
  async channels(@Query() q: QueryDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...query } = q;
    return toChannelsAnalytics(
      await this.rollups.channels(scopeOfMerchantUser(user, environment ?? 'live'), query)
    );
  }
}
