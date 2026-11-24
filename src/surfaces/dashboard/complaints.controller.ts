/**
 * `/merchant/v1/complaints` (spec 7.2): the merchant files a complaint, follows its thread (staff
 * replies, never internal notes), answers, and closes it. The session names the merchant; a
 * customer's complaint about the merchant is not shown here.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  complaintCategoriesSchema,
  merchantComplaintDetailSchema,
  merchantComplaintPageSchema,
  merchantComplaintSchema,
  toMerchantComplaint,
  toMerchantComplaintDetail,
} from '../../modules/complaints/complaint.views';
import { ComplaintsService } from '../../modules/complaints/complaints.service';
import {
  closeComplaintSchema,
  fileComplaintSchema,
  merchantComplaintListSchema,
  merchantMessageSchema,
} from '../shared/support.schemas';
import { refParamSchema } from '../shared/schemas';

class FileDto extends createZodDto(fileComplaintSchema) {}
class ListDto extends createZodDto(merchantComplaintListSchema) {}
class RefDto extends createZodDto(refParamSchema) {}
class MessageDto extends createZodDto(merchantMessageSchema) {}
class CloseDto extends createZodDto(closeComplaintSchema) {}

@ApiTags('Complaints')
@Controller('complaints')
export class DashboardComplaintsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Get('categories')
  @RequirePermission('complaints:read')
  @ApiOperation({ summary: 'The complaint categories, with the hours each is answered within' })
  @ApiEnvelopedResponses({ 200: complaintCategoriesSchema })
  async categories() {
    const rows = await this.complaints.categories();
    return {
      items: rows.map((c) => ({
        code: c.code,
        name: c.name,
        description: c.description,
        slaHours: c.slaHours,
        defaultPriority: c.defaultPriority as 'low' | 'normal' | 'high' | 'urgent',
      })),
    };
  }

  @Post()
  @RequirePermission('complaints:write')
  @Audited('complaint.created', 'complaint')
  @ApiOperation({
    summary: 'File a complaint',
    description:
      'Its deadline is the category’s hours from now. A transaction, if named, must be the merchant’s own.',
  })
  @ApiEnvelopedResponses({ 201: merchantComplaintSchema })
  async file(@Body() body: FileDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const created = await this.complaints.file(
      { scope: scopeOfMerchantUser(user, 'live'), userId: user.userId },
      {
        category: body.category,
        subject: body.subject,
        description: body.description,
        transactionRef: body.transaction,
        priority: body.priority,
      }
    );
    return toMerchantComplaint(created);
  }

  @Get()
  @RequirePermission('complaints:read')
  @ApiOperation({ summary: 'List the merchant’s complaints, newest first' })
  @ApiEnvelopedResponses({ 200: merchantComplaintPageSchema })
  async list(@Query() q: ListDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const page = await this.complaints.list(
      { status: q.status, category: q.category, limit: q.limit, cursor: q.cursor },
      scopeOfMerchantUser(user, 'live')
    );
    return { items: page.items.map(toMerchantComplaint), nextCursor: page.nextCursor };
  }

  @Get(':ref')
  @RequirePermission('complaints:read')
  @ApiOperation({ summary: 'One complaint with its public messages' })
  @ApiEnvelopedResponses({ 200: merchantComplaintDetailSchema })
  async get(@Param() p: RefDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return toMerchantComplaintDetail(
      await this.complaints.get(p.ref, scopeOfMerchantUser(user, 'live'))
    );
  }

  @Post(':ref/messages')
  @HttpCode(200)
  @RequirePermission('complaints:write')
  @Audited('complaint.message_added', 'complaint')
  @ApiOperation({ summary: 'Answer on a complaint' })
  @ApiEnvelopedResponses({ 200: merchantComplaintDetailSchema })
  async message(
    @Param() p: RefDto,
    @Body() body: MessageDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return toMerchantComplaintDetail(
      await this.complaints.addMessage(
        p.ref,
        { body: body.body },
        { merchant: { scope: scopeOfMerchantUser(user, 'live'), userId: user.userId } }
      )
    );
  }

  @Post(':ref/close')
  @HttpCode(200)
  @RequirePermission('complaints:write')
  @Audited('complaint.closed', 'complaint')
  @ApiOperation({
    summary: 'Close a complaint',
    description: 'A satisfaction score from 1 to 5 can be given once the complaint is resolved.',
  })
  @ApiEnvelopedResponses({ 200: merchantComplaintDetailSchema })
  async close(
    @Param() p: RefDto,
    @Body() body: CloseDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return toMerchantComplaintDetail(
      await this.complaints.close(
        { scope: scopeOfMerchantUser(user, 'live'), userId: user.userId },
        p.ref,
        { satisfactionScore: body.satisfactionScore }
      )
    );
  }
}
