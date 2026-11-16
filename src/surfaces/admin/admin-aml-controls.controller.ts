/**
 * `/admin/v1/aml/{screenings, rules, blocklist, blocks}` (spec 7.3): ad-hoc screening and the
 * decision on a potential match, the monitoring rules, the blocklist and the merchant block.
 *
 * Rule changes, blocklist changes, blocking and unblocking are step-up actions and audited.
 * A block holds the merchant's balance and suspends its payouts; it never reverses a payment.
 * `POST/GET blocks` and `POST /rules` are additions to spec 7.3, which lists no way to apply
 * or lift a block or to create a rule.
 */
import { randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { AmlStaffDirectory } from '../../modules/aml/aml-staff.directory';
import { AmlBlockService } from '../../modules/aml/block/aml-block.service';
import { AmlBlocklistService } from '../../modules/aml/blocklist/aml-blocklist.service';
import { AmlRulesService } from '../../modules/aml/rules/aml-rules.service';
import { AmlScreeningService } from '../../modules/aml/screening/aml-screening.service';
import { MerchantsRepository } from '../../modules/merchants/merchants.repository';
import {
  addBlocklistSchema,
  adHocScreeningSchema,
  blockListSchema,
  blockQuerySchema,
  blockSchema,
  blocklistEntrySchema,
  blocklistPageSchema,
  blocklistQuerySchema,
  codeParam,
  createBlockSchema,
  createRuleSchema,
  decideScreeningSchema,
  liftBlockSchema,
  patchRuleSchema,
  refParam,
  ruleListSchema,
  ruleSchema,
  screeningListQuerySchema,
  screeningPageSchema,
  screeningSchema,
} from '../shared/aml.schemas';
import { toBlockView, toBlocklistView, toRuleView, toScreeningView } from '../shared/aml.views';

class RefDto extends createZodDto(refParam) {}
class CodeDto extends createZodDto(codeParam) {}
class ScreeningListDto extends createZodDto(screeningListQuerySchema) {}
class AdHocDto extends createZodDto(adHocScreeningSchema) {}
class DecideDto extends createZodDto(decideScreeningSchema) {}
class CreateRuleDto extends createZodDto(createRuleSchema) {}
class PatchRuleDto extends createZodDto(patchRuleSchema) {}
class BlocklistListDto extends createZodDto(blocklistQuerySchema) {}
class AddBlocklistDto extends createZodDto(addBlocklistSchema) {}
class BlockListDto extends createZodDto(blockQuerySchema) {}
class CreateBlockDto extends createZodDto(createBlockSchema) {}
class LiftBlockDto extends createZodDto(liftBlockSchema) {}

@ApiTags('AML')
@Controller('aml')
export class AdminAmlControlsController {
  constructor(
    private readonly screenings: AmlScreeningService,
    private readonly rules: AmlRulesService,
    private readonly blocklist: AmlBlocklistService,
    private readonly blocks: AmlBlockService,
    private readonly directory: AmlStaffDirectory,
    private readonly merchants: MerchantsRepository
  ) {}

  // ---- screenings ----
  @Get('screenings')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'Screening results, newest first' })
  @ApiEnvelopedResponses({ 200: screeningPageSchema })
  async listScreenings(@Query() q: ScreeningListDto) {
    const merchant = q.merchant ? await this.merchants.findByRef(q.merchant) : undefined;
    if (q.merchant && !merchant) return { items: [], nextCursor: null };
    const page = await this.screenings.list({
      status: q.status,
      merchantId: merchant?.id,
      subjectType: q.subjectType,
      limit: q.limit,
      cursor: q.cursor,
    });
    const [merchantRefs, caseRefs] = await Promise.all([
      this.directory.merchantRefsOf(page.items.map((s) => s.merchantId)),
      this.directory.caseRefsOf(page.items.map((s) => s.caseId)),
    ]);
    return {
      items: page.items.map((s) =>
        toScreeningView(
          s,
          s.merchantId ? (merchantRefs.get(s.merchantId) ?? null) : null,
          s.caseId ? (caseRefs.get(s.caseId) ?? null) : null
        )
      ),
      nextCursor: page.nextCursor,
    };
  }

  @Post('screenings')
  @RequirePermission('aml:work')
  @Audited('aml.screening.completed', 'aml_screening')
  @ApiOperation({
    summary: 'Screen a person or organisation now',
    description:
      'Calls the screening provider and records the result. The name is sent to the provider ' +
      'and is not stored. A confirmed match opens an AML case.',
  })
  @ApiEnvelopedResponses({ 201: screeningSchema })
  async screenNow(@Body() body: AdHocDto, @CurrentStaff() staff: StaffPrincipal) {
    const merchant = body.merchant ? await this.merchants.findByRef(body.merchant) : undefined;
    if (body.merchant && !merchant) throw new AppError('NOT_FOUND');
    const row = await this.screenings.screen({
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      merchantId: merchant?.id ?? null,
      merchantRef: merchant?.ref ?? null,
      query: {
        entityType: body.entityType,
        name: body.name,
        ...(body.birthDate ? { birthDate: body.birthDate } : {}),
        ...(body.country ? { country: body.country } : {}),
      },
      dedupeKey: `adhoc:${randomUUID()}`,
      requestedBy: staff.userId,
    });
    const caseRefs = await this.directory.caseRefsOf([row.caseId]);
    return toScreeningView(
      row,
      merchant?.ref ?? null,
      row.caseId ? (caseRefs.get(row.caseId) ?? null) : null
    );
  }

  @Post('screenings/:ref/decide')
  @HttpCode(200)
  @RequirePermission('aml:work')
  @RequiresStepUp()
  @Audited('aml.screening.decided', 'aml_screening')
  @ApiOperation({
    summary: 'Decide a potential match: a false positive, or a real match',
    description: 'A real match opens an AML case and keeps the merchant from being activated.',
  })
  @ApiEnvelopedResponses({ 200: screeningSchema })
  async decide(@Param() p: RefDto, @Body() body: DecideDto, @CurrentStaff() staff: StaffPrincipal) {
    const row = await this.screenings.decide(p.ref, body.decision, body.note, staff.userId);
    const [merchantRefs, caseRefs] = await Promise.all([
      this.directory.merchantRefsOf([row.merchantId]),
      this.directory.caseRefsOf([row.caseId]),
    ]);
    return toScreeningView(
      row,
      row.merchantId ? (merchantRefs.get(row.merchantId) ?? null) : null,
      row.caseId ? (caseRefs.get(row.caseId) ?? null) : null
    );
  }

  // ---- rules ----
  @Get('rules')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'The monitoring rules' })
  @ApiEnvelopedResponses({ 200: ruleListSchema })
  async listRules() {
    return { items: (await this.rules.list()).map(toRuleView) };
  }

  @Post('rules')
  @RequirePermission('aml:rules')
  @RequiresStepUp()
  @Audited('aml.rule.created', 'aml_rule')
  @ApiOperation({
    summary: 'Create a monitoring rule',
    description:
      'Rules start disabled unless `enabled` is set. `params` depend on `ruleType`: the currency, ' +
      'the window, the thresholds. Amounts are strings of minor units.',
  })
  @ApiEnvelopedResponses({ 201: ruleSchema })
  async createRule(@Body() body: CreateRuleDto, @CurrentStaff() staff: StaffPrincipal) {
    return toRuleView(await this.rules.create(body, staff.userId));
  }

  @Patch('rules/:code')
  @RequirePermission('aml:rules')
  @RequiresStepUp()
  @Audited('aml.rule.updated', 'aml_rule')
  @ApiOperation({
    summary: 'Change a rule: enable or disable it, thresholds, window, severity, action, dates',
    description: 'Every change makes a new version, kept in the rule history and the audit trail.',
  })
  @ApiEnvelopedResponses({ 200: ruleSchema })
  async patchRule(
    @Param() p: CodeDto,
    @Body() body: PatchRuleDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    return toRuleView(await this.rules.update(p.code, body, staff.userId));
  }

  // ---- blocklist ----
  @Get('blocklist')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'Blocklist entries (only a hint of each value is kept)' })
  @ApiEnvelopedResponses({ 200: blocklistPageSchema })
  async listBlocklist(@Query() q: BlocklistListDto) {
    const page = await this.blocklist.list({
      entryType: q.type,
      includeRemoved: q.includeRemoved,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: page.items.map(toBlocklistView), nextCursor: page.nextCursor };
  }

  @Post('blocklist')
  @RequirePermission('aml:blocklist')
  @RequiresStepUp()
  @Audited('aml.blocklist.added', 'aml_blocklist')
  @ApiOperation({ summary: 'Add to the blocklist' })
  @ApiEnvelopedResponses({ 201: blocklistEntrySchema })
  async addBlocklist(@Body() body: AddBlocklistDto, @CurrentStaff() staff: StaffPrincipal) {
    return toBlocklistView(await this.blocklist.add(body, staff.userId));
  }

  @Delete('blocklist/:ref')
  @HttpCode(200)
  @RequirePermission('aml:blocklist')
  @RequiresStepUp()
  @Audited('aml.blocklist.removed', 'aml_blocklist')
  @ApiOperation({
    summary: 'Remove from the blocklist',
    description: 'The entry is marked removed, never deleted.',
  })
  @ApiEnvelopedResponses({ 200: blocklistEntrySchema })
  async removeBlocklist(@Param() p: RefDto, @CurrentStaff() staff: StaffPrincipal) {
    return toBlocklistView(await this.blocklist.remove(p.ref, staff.userId));
  }

  // ---- blocks ----
  @Get('blocks')
  @RequirePermission('aml:read')
  @ApiOperation({ summary: 'Merchant blocks' })
  @ApiEnvelopedResponses({ 200: blockListSchema })
  async listBlocks(@Query() q: BlockListDto) {
    const merchant = q.merchant ? await this.merchants.findByRef(q.merchant) : undefined;
    if (q.merchant && !merchant) return { items: [] };
    const rows = await this.blocks.list({
      merchantId: merchant?.id,
      status: q.status,
      limit: q.limit,
    });
    return { items: rows.map((r) => toBlockView(r.block, r.merchantRef, [])) };
  }

  @Post('blocks')
  @RequirePermission('aml:block')
  @RequiresStepUp()
  @Audited('aml.merchant.blocked', 'aml_block')
  @ApiOperation({
    summary: 'Block a merchant',
    description:
      'Holds the merchant’s available balance and suspends its payouts. Completed ' +
      'transactions are not touched. Blocking a blocked merchant returns the existing block.',
  })
  @ApiEnvelopedResponses({ 201: blockSchema })
  async block(@Body() body: CreateBlockDto, @CurrentStaff() staff: StaffPrincipal) {
    const result = await this.blocks.block(body.merchant, body.reason, {
      userId: staff.userId,
      userRef: staff.userRef,
    });
    return toBlockView(result.block, body.merchant, result.heldCurrencies, result.created);
  }

  @Post('blocks/:ref/lift')
  @HttpCode(200)
  @RequirePermission('aml:block')
  @RequiresStepUp()
  @Audited('aml.merchant.unblocked', 'aml_block')
  @ApiOperation({ summary: 'Lift a block: release its holds and let payouts resume' })
  @ApiEnvelopedResponses({ 200: blockSchema })
  async lift(
    @Param() p: RefDto,
    @Body() body: LiftBlockDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    await this.blocks.lift(p.ref, body.note, staff.userId);
    const found = await this.blocks.get(p.ref);
    return toBlockView(
      found.block,
      found.merchantRef,
      found.holds.map((h) => h.currency)
    );
  }
}
