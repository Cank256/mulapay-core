/**
 * `/admin/v1/disputes` (spec 7.3): the dispute queue, recording a dispute notice, moving it
 * into investigation, and resolving it.
 *
 * Opening a dispute holds the disputed amount on the merchant's balance. Resolving releases
 * the hold (merchant won or withdrawn) or captures it and posts to the ledger (merchant lost),
 * in one transaction. Resolving is a step-up action. `POST /disputes` is an addition to spec
 * 7.3, which lists no way to record a chargeback notice.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  adminDisputePageSchema,
  adminDisputeSchema,
  toAdminDispute,
} from '../../modules/disputes/dispute.views';
import { DisputesService } from '../../modules/disputes/disputes.service';
import {
  adminDisputeListQuerySchema,
  openDisputeSchema,
  patchDisputeSchema,
  resolveDisputeSchema,
} from '../shared/dispute.schemas';
import { refParamSchema } from '../shared/schemas';

class ListDto extends createZodDto(adminDisputeListQuerySchema) {}
class RefDto extends createZodDto(refParamSchema) {}
class OpenDto extends createZodDto(openDisputeSchema) {}
class PatchDto extends createZodDto(patchDisputeSchema) {}
class ResolveDto extends createZodDto(resolveDisputeSchema) {}

@ApiTags('Disputes')
@Controller('disputes')
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermission('chargebacks:read')
  @ApiOperation({ summary: 'Disputes, newest first' })
  @ApiEnvelopedResponses({ 200: adminDisputePageSchema })
  async list(@Query() q: ListDto) {
    const page = await this.disputes.list({
      merchantRef: q.merchant,
      status: q.status,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: page.items.map(toAdminDispute), nextCursor: page.nextCursor };
  }

  @Post()
  @RequirePermission('chargebacks:work')
  @Audited('dispute.created', 'dispute')
  @ApiOperation({
    summary: 'Record a dispute and hold the disputed amount',
    description:
      'For a successful live payment, for at most its amount. Holds what the merchant’s ' +
      'available balance can cover and records any shortfall.',
  })
  @ApiEnvelopedResponses({ 201: adminDisputeSchema })
  async open(@Body() body: OpenDto, @CurrentStaff() staff: StaffPrincipal) {
    return toAdminDispute(
      await this.disputes.open(
        {
          merchantRef: body.merchant,
          transactionRef: body.transaction,
          kind: body.kind,
          amountMinor: body.amountMinor,
          reasonCode: body.reasonCode,
          evidenceDueAt: body.evidenceDueAt,
          internalNote: body.internalNote,
        },
        { userId: staff.userId, userRef: staff.userRef }
      )
    );
  }

  @Get(':ref')
  @RequirePermission('chargebacks:read')
  @ApiOperation({ summary: 'One dispute' })
  @ApiEnvelopedResponses({ 200: adminDisputeSchema })
  async get(@Param() p: RefDto) {
    return toAdminDispute(await this.disputes.getAny(p.ref));
  }

  @Patch(':ref')
  @RequirePermission('chargebacks:work')
  @Audited('dispute.updated', 'dispute')
  @ApiOperation({
    summary: 'Start the investigation, set the evidence due date, add an internal note',
  })
  @ApiEnvelopedResponses({ 200: adminDisputeSchema })
  async patch(@Param() p: RefDto, @Body() body: PatchDto) {
    return toAdminDispute(await this.disputes.update(p.ref, body));
  }

  @Post(':ref/resolve')
  @HttpCode(200)
  @RequirePermission('chargebacks:resolve')
  @RequiresStepUp()
  @Audited('dispute.resolved', 'dispute')
  @ApiOperation({
    summary: 'Resolve a dispute',
    description:
      '`merchant_won` and `withdrawn` release the hold. `merchant_lost` captures it and posts ' +
      'to the ledger: a reversal of the payment’s entry when the whole payment is disputed, a ' +
      'compensating entry for a partial amount. `acceptDeficit` lets a lost dispute take the ' +
      'merchant’s balance below zero.',
  })
  @ApiEnvelopedResponses({ 200: adminDisputeSchema })
  async resolve(
    @Param() p: RefDto,
    @Body() body: ResolveDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toAdminDispute(
      await this.disputes.resolve(p.ref, body, { userId: staff.userId, userRef: staff.userRef })
    );
  }
}
