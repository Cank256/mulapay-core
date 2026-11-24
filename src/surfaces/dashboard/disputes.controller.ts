/**
 * `/merchant/v1/disputes` (spec 7.2): the merchant's disputes and chargebacks, and its
 * evidence. Live only: a dispute is about real money. The session names the merchant.
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
  merchantDisputePageSchema,
  merchantDisputeSchema,
  toMerchantDispute,
} from '../../modules/disputes/dispute.views';
import { DisputesService } from '../../modules/disputes/disputes.service';
import { disputeListQuerySchema, evidenceBodySchema } from '../shared/dispute.schemas';
import { refParamSchema } from '../shared/schemas';

class ListDto extends createZodDto(disputeListQuerySchema) {}
class RefDto extends createZodDto(refParamSchema) {}
class EvidenceDto extends createZodDto(evidenceBodySchema) {}

@ApiTags('Disputes')
@Controller('disputes')
export class DashboardDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermission('disputes:read')
  @ApiOperation({ summary: 'List disputes against the merchant, newest first' })
  @ApiEnvelopedResponses({ 200: merchantDisputePageSchema })
  async list(@Query() q: ListDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const page = await this.disputes.list({
      scope: scopeOfMerchantUser(user, 'live'),
      status: q.status,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: page.items.map(toMerchantDispute), nextCursor: page.nextCursor };
  }

  @Get(':ref')
  @RequirePermission('disputes:read')
  @ApiOperation({ summary: 'One dispute' })
  @ApiEnvelopedResponses({ 200: merchantDisputeSchema })
  async get(@Param() p: RefDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return toMerchantDispute(await this.disputes.get(scopeOfMerchantUser(user, 'live'), p.ref));
  }

  @Post(':ref/evidence')
  @HttpCode(200)
  @RequirePermission('disputes:write')
  @Audited('dispute.evidence_added', 'dispute')
  @ApiOperation({
    summary: 'Add evidence to a dispute',
    description: 'Allowed until the evidence due date, at most 20 items of 2,000 characters.',
  })
  @ApiEnvelopedResponses({ 200: merchantDisputeSchema })
  async addEvidence(
    @Param() p: RefDto,
    @Body() body: EvidenceDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return toMerchantDispute(
      await this.disputes.addEvidence(scopeOfMerchantUser(user, 'live'), p.ref, body.text)
    );
  }
}
