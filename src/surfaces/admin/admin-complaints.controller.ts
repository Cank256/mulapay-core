/**
 * `/admin/v1/complaints` (spec 7.3): the support queue. Staff record complaints on someone's
 * behalf (a customer's call, a merchant's email: an addition to the spec's catalogue), assign,
 * answer, add internal notes, escalate and resolve. The breach queue lists unresolved complaints
 * past their deadline, longest overdue first. Resolving is a step-up action.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  adminComplaintDetailSchema,
  adminComplaintPageSchema,
  adminComplaintSchema,
  complaintCategoriesSchema,
  customerContactSchema,
  toAdminComplaint,
  toAdminComplaintDetail,
} from '../../modules/complaints/complaint.views';
import { ComplaintsService } from '../../modules/complaints/complaints.service';
import {
  adminComplaintListSchema,
  adminMessageSchema,
  assignSchema,
  complaintBreachListSchema,
  escalateComplaintSchema,
  recordComplaintSchema,
  resolveComplaintSchema,
} from '../shared/support.schemas';
import { refParamSchema } from '../shared/schemas';

class ListDto extends createZodDto(adminComplaintListSchema) {}
class BreachDto extends createZodDto(complaintBreachListSchema) {}
class RefDto extends createZodDto(refParamSchema) {}
class RecordDto extends createZodDto(recordComplaintSchema) {}
class MessageDto extends createZodDto(adminMessageSchema) {}
class AssignDto extends createZodDto(assignSchema) {}
class EscalateDto extends createZodDto(escalateComplaintSchema) {}
class ResolveDto extends createZodDto(resolveComplaintSchema) {}

const staffOf = (s: StaffPrincipal) => ({ userId: s.userId, userRef: s.userRef });

@ApiTags('Complaints')
@Controller('complaints')
export class AdminComplaintsController {
  constructor(private readonly complaints: ComplaintsService) {}

  @Get()
  @RequirePermission('support:read')
  @ApiOperation({ summary: 'The complaint queue, newest first' })
  @ApiEnvelopedResponses({ 200: adminComplaintPageSchema })
  async list(@Query() q: ListDto) {
    const page = await this.complaints.list({
      status: q.status,
      category: q.category,
      priority: q.priority,
      source: q.source,
      merchantRef: q.merchant,
      assignedToRef: q.assignee,
      unassigned: q.unassigned,
      breached: q.breached,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: page.items.map(toAdminComplaint), nextCursor: page.nextCursor };
  }

  @Get('sla-breaches')
  @RequirePermission('support:read')
  @ApiOperation({
    summary: 'Unresolved complaints past their deadline, longest overdue first',
    description: 'Staff are also notified when a complaint breaches.',
  })
  @ApiEnvelopedResponses({ 200: adminComplaintPageSchema })
  async breaches(@Query() q: BreachDto) {
    const page = await this.complaints.breaches({ limit: q.limit, cursor: q.cursor });
    return { items: page.items.map(toAdminComplaint), nextCursor: page.nextCursor };
  }

  @Get('categories')
  @RequirePermission('support:read')
  @ApiOperation({ summary: 'The categories, with the hours each is answered within' })
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
  @RequirePermission('support:work')
  @Audited('complaint.created', 'complaint')
  @ApiOperation({
    summary: 'Record a complaint on someone’s behalf',
    description:
      'For a customer’s call or a merchant’s email. A customer’s contact is stored encrypted. When a transaction is named and no merchant is, the complaint is about that transaction’s merchant.',
  })
  @ApiEnvelopedResponses({ 201: adminComplaintSchema })
  async record(@Body() body: RecordDto, @CurrentStaff() staff: StaffPrincipal) {
    return toAdminComplaint(
      await this.complaints.record(
        {
          source: body.source,
          merchantRef: body.merchant,
          category: body.category,
          subject: body.subject,
          description: body.description,
          transactionRef: body.transaction,
          priority: body.priority,
          customerContact: body.customerContact,
        },
        staffOf(staff)
      )
    );
  }

  @Get(':ref')
  @RequirePermission('support:read')
  @ApiOperation({ summary: 'One complaint with its whole thread, internal notes included' })
  @ApiEnvelopedResponses({ 200: adminComplaintDetailSchema })
  async get(@Param() p: RefDto) {
    return toAdminComplaintDetail(await this.complaints.get(p.ref));
  }

  @Get(':ref/contact')
  @RequirePermission('support:work')
  @Audited('complaint.contact_viewed', 'complaint')
  @ApiOperation({
    summary: 'The customer’s contact details',
    description: 'Stored encrypted; reading it is audited.',
  })
  @ApiEnvelopedResponses({ 200: customerContactSchema })
  async contact(@Param() p: RefDto) {
    return { contact: await this.complaints.revealContact(p.ref) };
  }

  @Post(':ref/assign')
  @HttpCode(200)
  @RequirePermission('support:work')
  @Audited('complaint.assigned', 'complaint')
  @ApiOperation({ summary: 'Assign a complaint to a staff member' })
  @ApiEnvelopedResponses({ 200: adminComplaintSchema })
  async assign(@Param() p: RefDto, @Body() body: AssignDto, @CurrentStaff() staff: StaffPrincipal) {
    return toAdminComplaint(await this.complaints.assign(p.ref, body.assignee, staffOf(staff)));
  }

  @Post(':ref/messages')
  @HttpCode(200)
  @RequirePermission('support:work')
  @Audited('complaint.message_added', 'complaint')
  @ApiOperation({
    summary: 'Answer on a complaint, or add an internal note',
    description:
      '`internal: true` is for staff only and is never shown to the merchant. `awaitCustomer: true` moves the complaint to awaiting_customer.',
  })
  @ApiEnvelopedResponses({ 200: adminComplaintDetailSchema })
  async message(
    @Param() p: RefDto,
    @Body() body: MessageDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toAdminComplaintDetail(
      await this.complaints.addMessage(
        p.ref,
        { body: body.body, internal: body.internal, awaitCustomer: body.awaitCustomer },
        { staff: staffOf(staff) }
      )
    );
  }

  @Post(':ref/escalate')
  @HttpCode(200)
  @RequirePermission('support:work')
  @Audited('complaint.escalated', 'complaint')
  @ApiOperation({ summary: 'Escalate a complaint to a supervisor' })
  @ApiEnvelopedResponses({ 200: adminComplaintSchema })
  async escalate(
    @Param() p: RefDto,
    @Body() body: EscalateDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toAdminComplaint(await this.complaints.escalate(p.ref, body.reason, staffOf(staff)));
  }

  @Post(':ref/resolve')
  @HttpCode(200)
  @RequirePermission('support:resolve')
  @RequiresStepUp()
  @Audited('complaint.resolved', 'complaint')
  @ApiOperation({ summary: 'Resolve a complaint' })
  @ApiEnvelopedResponses({ 200: adminComplaintSchema })
  async resolve(
    @Param() p: RefDto,
    @Body() body: ResolveDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toAdminComplaint(await this.complaints.resolve(p.ref, body.resolution, staffOf(staff)));
  }
}
