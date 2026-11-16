/**
 * `/admin/v1/notification-templates`, `/notifications` and `/notification-destinations`
 * (spec 7.3): templates, announcements, and the delivery log that makes notification retries
 * and failures observable. A staff member's own destinations (SMS, push) are set here too.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { Authenticated, RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { AppError } from '../../common/errors/app-error';
import { MerchantsRepository } from '../../modules/merchants/merchants.repository';
import {
  broadcastResultSchema,
  deliveryPageSchema,
  destinationSchema,
  destinationsSchema,
  templateSchema,
  templatesSchema,
  toDelivery,
  toDestination,
  toTemplate,
} from '../../modules/notifications/notification.views';
import { NotificationsRepository } from '../../modules/notifications/notifications.repository';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { decodeCursor, filterFingerprint, toPage } from '../../common/pagination/cursor';
import { resolveWindow } from '../../common/pagination/window';
import { Inject } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import { CLOCK } from '../../common/tokens';
import {
  broadcastSchema,
  deliveryListSchema,
  destinationParamSchema,
  saveTemplateSchema,
  setDestinationSchema,
  templateListSchema,
  templateParamSchema,
} from '../shared/support.schemas';

class TemplateListDto extends createZodDto(templateListSchema) {}
class TemplateParamDto extends createZodDto(templateParamSchema) {}
class SaveTemplateDto extends createZodDto(saveTemplateSchema) {}
class BroadcastDto extends createZodDto(broadcastSchema) {}
class DeliveryListDto extends createZodDto(deliveryListSchema) {}
class DestinationParamDto extends createZodDto(destinationParamSchema) {}
class SetDestinationDto extends createZodDto(setDestinationSchema) {}
const removedSchema = z.object({ removed: z.literal(true) });

@ApiTags('Notifications')
@Controller()
export class AdminNotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly repository: NotificationsRepository,
    private readonly merchants: MerchantsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  @Get('notification-templates')
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'Notification templates by code and channel' })
  @ApiEnvelopedResponses({ 200: templatesSchema })
  async templates(@Query() q: TemplateListDto) {
    return { items: (await this.notifications.listTemplates(q)).map(toTemplate) };
  }

  @Put('notification-templates/:code/:channel')
  @RequirePermission('notification_templates:manage')
  @Audited('notification_template.saved', 'notification_template')
  @ApiOperation({
    summary: 'Create or replace a template',
    description:
      'Placeholders are `{{name}}`; every one must be declared in `variables` and every declared variable used. A mandatory template ignores recipients’ preferences.',
  })
  @ApiEnvelopedResponses({ 200: templateSchema })
  async saveTemplate(@Param() p: TemplateParamDto, @Body() body: SaveTemplateDto) {
    return toTemplate(
      await this.notifications.saveTemplate({
        code: p.code,
        channel: p.channel,
        subject: body.subject ?? null,
        body: body.body,
        variables: body.variables,
        mandatory: body.mandatory,
        audience: body.audience,
        active: body.active,
      })
    );
  }

  @Post('notifications/broadcast')
  @HttpCode(200)
  @RequirePermission('notification_templates:manage')
  @Audited('notification.broadcast', 'notification')
  @ApiOperation({
    summary: 'Announce something to all staff, or to the owners and admins of merchants',
    description: 'At most 1,000 recipients; name merchants to narrow it.',
  })
  @ApiEnvelopedResponses({ 200: broadcastResultSchema })
  async broadcast(@Body() body: BroadcastDto) {
    const ids = body.merchants
      ? await Promise.all(
          body.merchants.map(async (ref) => {
            const merchant = await this.merchants.findByRef(ref);
            if (!merchant) throw new AppError('NOT_FOUND');
            return merchant.id;
          })
        )
      : undefined;
    return this.notifications.broadcast({
      audience: body.audience,
      merchantIds: ids,
      headline: body.headline,
      message: body.message,
    });
  }

  @Get('notifications/deliveries')
  @RequirePermission('ops:read')
  @ApiOperation({
    summary: 'The delivery log: every attempt’s outcome, retries and failures',
    description:
      'Filter by `status` (pending, sent, failed) and `channel`. Window defaults to 90 days.',
  })
  @ApiEnvelopedResponses({ 200: deliveryPageSchema })
  async deliveries(@Query() q: DeliveryListDto) {
    const window = resolveWindow({ from: q.from, to: q.to }, this.clock.now());
    const fingerprint = filterFingerprint({
      status: q.status,
      channel: q.channel,
      from: window.from.toISOString(),
    });
    const after = q.cursor ? decodeCursor(q.cursor, fingerprint) : undefined;
    const rows = await this.repository.deliveryLog({
      status: q.status,
      channel: q.channel,
      from: window.from,
      to: window.to,
      after,
      limit: q.limit,
    });
    const page = toPage(rows, q.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
    return { items: page.items.map(toDelivery), nextCursor: page.nextCursor };
  }

  @Get('notification-destinations')
  @Authenticated()
  @ApiOperation({ summary: 'Where your SMS and push notifications go' })
  @ApiEnvelopedResponses({ 200: destinationsSchema })
  async destinations(@CurrentStaff() staff: StaffPrincipal) {
    return { items: (await this.notifications.listDestinations(staff.userId)).map(toDestination) };
  }

  @Put('notification-destinations/:channel')
  @Authenticated()
  @Audited('notification_destination.set', 'notification_destination')
  @ApiOperation({ summary: 'Set your phone number (sms) or device token (push)' })
  @ApiEnvelopedResponses({ 200: destinationSchema })
  async setDestination(
    @Param() p: DestinationParamDto,
    @Body() body: SetDestinationDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toDestination(
      await this.notifications.setDestination(staff.userId, p.channel, body.address)
    );
  }

  @Delete('notification-destinations/:channel')
  @HttpCode(200)
  @Authenticated()
  @Audited('notification_destination.removed', 'notification_destination')
  @ApiOperation({ summary: 'Stop notifying this channel' })
  @ApiEnvelopedResponses({ 200: removedSchema })
  async removeDestination(@Param() p: DestinationParamDto, @CurrentStaff() staff: StaffPrincipal) {
    await this.notifications.removeDestination(staff.userId, p.channel);
    return { removed: true as const };
  }
}
