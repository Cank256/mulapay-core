/**
 * `/merchant/v1/notifications`, `/notification-preferences` and `/notification-destinations`
 * (spec 7.2): the in-app inbox with its unread count, marking read (one or all), the channels the
 * user wants, and where SMS and push go. Every route is about the signed-in user only, so no
 * permission beyond being signed in is needed, and nobody can read another user's inbox.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { Authenticated } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  destinationSchema,
  destinationsSchema,
  inAppNotificationPageSchema,
  markedReadSchema,
  preferencesSchema,
  readAllSchema,
  toDestination,
  toInAppNotification,
  unreadCountSchema,
} from '../../modules/notifications/notification.views';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import {
  destinationParamSchema,
  inboxListSchema,
  readParamSchema,
  setDestinationSchema,
  setPreferencesSchema,
} from '../shared/support.schemas';

const removedSchema = z.object({ removed: z.literal(true) });
class InboxDto extends createZodDto(inboxListSchema) {}
class ReadParamDto extends createZodDto(readParamSchema) {}
class SetPreferencesDto extends createZodDto(setPreferencesSchema) {}
class DestinationParamDto extends createZodDto(destinationParamSchema) {}
class SetDestinationDto extends createZodDto(setDestinationSchema) {}

@ApiTags('Notifications')
@Controller()
export class DashboardNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications')
  @Authenticated()
  @ApiOperation({ summary: 'The in-app inbox, newest first' })
  @ApiEnvelopedResponses({ 200: inAppNotificationPageSchema })
  async inbox(@Query() q: InboxDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const page = await this.notifications.inbox(user.userId, {
      unreadOnly: q.unread === true,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: page.items.map(toInAppNotification), nextCursor: page.nextCursor };
  }

  @Get('notifications/unread-count')
  @Authenticated()
  @ApiOperation({ summary: 'How many in-app notifications are unread' })
  @ApiEnvelopedResponses({ 200: unreadCountSchema })
  async unread(@CurrentMerchantUser() user: MerchantUserPrincipal) {
    return { unread: await this.notifications.unreadCount(user.userId) };
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  @Authenticated()
  @Audited('notification.read_all', 'notification')
  @ApiOperation({ summary: 'Mark every unread notification read' })
  @ApiEnvelopedResponses({ 200: readAllSchema })
  async readAll(@CurrentMerchantUser() user: MerchantUserPrincipal) {
    return { marked: await this.notifications.markAllRead(user.userId) };
  }

  @Post('notifications/:ref/read')
  @HttpCode(200)
  @Authenticated()
  @Audited('notification.read', 'notification')
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiEnvelopedResponses({ 200: markedReadSchema })
  async read(@Param() p: ReadParamDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    await this.notifications.markRead(user.userId, p.ref);
    return { read: true as const };
  }

  @Get('notification-preferences')
  @Authenticated()
  @ApiOperation({ summary: 'The channels the user has switched on or off, per notification type' })
  @ApiEnvelopedResponses({ 200: preferencesSchema })
  async preferences(@CurrentMerchantUser() user: MerchantUserPrincipal) {
    const rows = await this.notifications.listPreferences(user.userId);
    return {
      items: rows.map((r) => ({
        template: r.templateCode,
        channel: r.channel,
        enabled: r.enabled,
      })),
    };
  }

  @Patch('notification-preferences')
  @Authenticated()
  @Audited('notification_preferences.updated', 'notification_preferences')
  @ApiOperation({
    summary: 'Switch channels on or off',
    description:
      '`template: "*"` applies to every notification on the channel. Required notifications (security, disputes) cannot be switched off.',
  })
  @ApiEnvelopedResponses({ 200: preferencesSchema })
  async setPreferences(
    @Body() body: SetPreferencesDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    await this.notifications.setPreferences(
      user.userId,
      body.preferences.map((p) => ({
        templateCode: p.template,
        channel: p.channel,
        enabled: p.enabled,
      }))
    );
    return this.preferences(user);
  }

  @Get('notification-destinations')
  @Authenticated()
  @ApiOperation({
    summary: 'Where SMS and push notifications go (addresses are never returned in full)',
  })
  @ApiEnvelopedResponses({ 200: destinationsSchema })
  async destinations(@CurrentMerchantUser() user: MerchantUserPrincipal) {
    return { items: (await this.notifications.listDestinations(user.userId)).map(toDestination) };
  }

  @Put('notification-destinations/:channel')
  @Authenticated()
  @Audited('notification_destination.set', 'notification_destination')
  @ApiOperation({ summary: 'Set the phone number (sms) or device token (push) to notify' })
  @ApiEnvelopedResponses({ 200: destinationSchema })
  async setDestination(
    @Param() p: DestinationParamDto,
    @Body() body: SetDestinationDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return toDestination(
      await this.notifications.setDestination(user.userId, p.channel, body.address)
    );
  }

  @Delete('notification-destinations/:channel')
  @HttpCode(200)
  @Authenticated()
  @Audited('notification_destination.removed', 'notification_destination')
  @ApiOperation({ summary: 'Stop notifying this channel' })
  @ApiEnvelopedResponses({ 200: removedSchema })
  async removeDestination(
    @Param() p: DestinationParamDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    await this.notifications.removeDestination(user.userId, p.channel);
    return { removed: true as const };
  }
}
