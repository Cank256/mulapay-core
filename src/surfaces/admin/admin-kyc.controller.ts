/**
 * `/admin/v1/kyc/*` (spec 7.3): the KYC review queue, one merchant's file, approval and
 * rejection, requests for information, document review and audited viewing, and the
 * requirements data.
 *
 * Approval is a step-up action and is refused for anyone who verified that submission's
 * documents (maker-checker, spec 11). Opening a document returns a link that lasts five
 * minutes at most and writes an audit row before it is issued. `checks` and the requirement
 * writes are additions to spec 7.3, which lists no way to record a manual check.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { KycAdminService } from '../../modules/kyc/kyc-admin.service';
import { KycDocumentsService } from '../../modules/kyc/kyc-documents.service';
import { KycRequirementsService, toDomainRow } from '../../modules/kyc/kyc-requirements.service';
import { KycReviewService } from '../../modules/kyc/kyc-review.service';
import { toDocumentView } from '../../modules/kyc/kyc.views';
import {
  adminDetailSchema,
  approveBodySchema,
  checkBodySchema,
  decisionResultSchema,
  documentParamSchema,
  documentViewResultSchema,
  merchantRefParamSchema,
  okSchema,
  queuePageSchema,
  queueQuerySchema,
  rejectBodySchema,
  requestInfoBodySchema,
  requirementCreateSchema,
  requirementIdParamSchema,
  requirementListQuerySchema,
  requirementListSchema,
  requirementPatchSchema,
  requirementRowSchema,
  verifyDocumentBodySchema,
} from '../shared/kyc.schemas';

class QueueDto extends createZodDto(queueQuerySchema) {}
class MerchantParamDto extends createZodDto(merchantRefParamSchema) {}
class DocumentParamDto extends createZodDto(documentParamSchema) {}
class ApproveDto extends createZodDto(approveBodySchema) {}
class RejectDto extends createZodDto(rejectBodySchema) {}
class RequestInfoDto extends createZodDto(requestInfoBodySchema) {}
class VerifyDto extends createZodDto(verifyDocumentBodySchema) {}
class CheckDto extends createZodDto(checkBodySchema) {}
class RequirementListDto extends createZodDto(requirementListQuerySchema) {}
class RequirementCreateDto extends createZodDto(requirementCreateSchema) {}
class RequirementPatchDto extends createZodDto(requirementPatchSchema) {}
class RequirementIdDto extends createZodDto(requirementIdParamSchema) {}

function requirementView(row: Parameters<typeof toDomainRow>[0]) {
  return {
    id: row.id,
    level: row.level,
    country: row.country,
    businessType: row.businessType,
    code: row.requirementCode,
    kind: toDomainRow(row).kind,
    evidenceKey: row.evidenceKey,
    label: row.label,
    description: row.description,
    mandatory: row.mandatory,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

@ApiTags('KYC')
@Controller('kyc')
export class AdminKycController {
  constructor(
    private readonly admin: KycAdminService,
    private readonly review: KycReviewService,
    private readonly documents: KycDocumentsService,
    private readonly requirements: KycRequirementsService
  ) {}

  @Get('queue')
  @RequirePermission('kyc:read')
  @ApiOperation({ summary: 'Submissions waiting for review, newest first' })
  @ApiEnvelopedResponses({ 200: queuePageSchema })
  async queue(@Query() q: QueueDto) {
    const page = await this.review.queue(q);
    return {
      items: page.items.map(({ profile, merchantRef, merchantName }) => ({
        merchant: merchantRef,
        legalName: merchantName,
        status: profile.status as 'pending' | 'in_review',
        level: profile.level,
        submissionNo: profile.submissionNo,
        submittedAt: profile.submittedAt?.toISOString() ?? null,
        isReverification: profile.isReverification,
      })),
      nextCursor: page.nextCursor,
    };
  }

  // ---- requirements (data) ----
  @Get('requirements')
  @RequirePermission('kyc:read')
  @ApiOperation({
    summary: 'The requirements data',
    description: 'Rows by level, country (`*` for all) and business type (`*` for all).',
  })
  @ApiEnvelopedResponses({ 200: requirementListSchema })
  async listRequirements(@Query() q: RequirementListDto) {
    return { items: (await this.requirements.list(q)).map(requirementView) };
  }

  @Post('requirements')
  @RequirePermission('kyc:requirements')
  @RequiresStepUp()
  @Audited('kyc.requirement.created', 'kyc_requirement')
  @ApiOperation({ summary: 'Add a requirement' })
  @ApiEnvelopedResponses({ 201: requirementRowSchema })
  async createRequirement(@Body() body: RequirementCreateDto) {
    const { code, ...rest } = body;
    return requirementView(await this.requirements.create({ ...rest, requirementCode: code }));
  }

  @Patch('requirements/:id')
  @RequirePermission('kyc:requirements')
  @RequiresStepUp()
  @Audited('kyc.requirement.updated', 'kyc_requirement')
  @ApiOperation({ summary: 'Change a requirement' })
  @ApiEnvelopedResponses({ 200: requirementRowSchema })
  async updateRequirement(@Param() p: RequirementIdDto, @Body() body: RequirementPatchDto) {
    return requirementView(await this.requirements.update(p.id, body));
  }

  @Delete('requirements/:id')
  @HttpCode(200)
  @RequirePermission('kyc:requirements')
  @RequiresStepUp()
  @Audited('kyc.requirement.updated', 'kyc_requirement')
  @ApiOperation({
    summary: 'Deactivate a requirement',
    description: 'Requirements are never deleted, so the record of what was asked stays.',
  })
  @ApiEnvelopedResponses({ 200: requirementRowSchema })
  async deactivateRequirement(@Param() p: RequirementIdDto) {
    return requirementView(await this.requirements.deactivate(p.id));
  }

  // ---- one merchant ----
  @Get(':merchantRef')
  @RequirePermission('kyc:read')
  @ApiOperation({ summary: 'A merchant’s KYC file' })
  @ApiEnvelopedResponses({ 200: adminDetailSchema })
  detail(@Param() p: MerchantParamDto) {
    return this.admin.detail(p.merchantRef);
  }

  @Post(':merchantRef/approve')
  @HttpCode(200)
  @RequirePermission('kyc:approve')
  @RequiresStepUp()
  @Audited('kyc.approved', 'kyc_profile')
  @ApiOperation({
    summary: 'Approve KYC and activate the merchant',
    description:
      'In one transaction: the KYC status, the merchant’s level and status, and its limits. ' +
      'Refused unless every mandatory requirement is verified, every person on the application ' +
      'has a clear screening, and the approver did not verify any of its documents.',
  })
  @ApiEnvelopedResponses({ 200: decisionResultSchema })
  async approve(
    @Param() p: MerchantParamDto,
    @Body() body: ApproveDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    const merchant = await this.review.approve(p.merchantRef, staff.userId, body.note);
    return { merchant: merchant.ref, status: merchant.status, level: merchant.kycLevel };
  }

  @Post(':merchantRef/reject')
  @HttpCode(200)
  @RequirePermission('kyc:review')
  @Audited('kyc.rejected', 'kyc_profile')
  @ApiOperation({
    summary: 'Reject KYC with structured reasons',
    description: 'Each reason is a code, optionally pointing at a document, party or requirement.',
  })
  @ApiEnvelopedResponses({ 200: okSchema })
  async reject(
    @Param() p: MerchantParamDto,
    @Body() body: RejectDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    await this.review.reject(p.merchantRef, body.reasons, body.note, staff.userId);
    return { ok: true as const };
  }

  @Post(':merchantRef/request-info')
  @HttpCode(200)
  @RequirePermission('kyc:review')
  @Audited('kyc.info_requested', 'kyc_profile')
  @ApiOperation({ summary: 'Ask the merchant for more information' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async requestInfo(
    @Param() p: MerchantParamDto,
    @Body() body: RequestInfoDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    await this.review.requestInfo(p.merchantRef, body.note, staff.userId);
    return { ok: true as const };
  }

  @Post(':merchantRef/checks')
  @HttpCode(200)
  @RequirePermission('kyc:review')
  @Audited('kyc.check.recorded', 'kyc_profile')
  @ApiOperation({
    summary: 'Record a check made by hand: contact, address, bank account, registry',
  })
  @ApiEnvelopedResponses({ 200: okSchema })
  async recordCheck(
    @Param() p: MerchantParamDto,
    @Body() body: CheckDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    await this.review.recordCheck(p.merchantRef, body, staff.userId);
    return { ok: true as const };
  }

  @Get(':merchantRef/documents/:id/view')
  @RequirePermission('kyc:view_documents')
  @ApiOperation({
    summary: 'A short-lived link to open a document',
    description: 'Presigned, valid for at most five minutes. Every call writes an audit row.',
  })
  @ApiEnvelopedResponses({ 200: documentViewResultSchema })
  async viewDocument(@Param() p: DocumentParamDto) {
    const { document, url } = await this.documents.view(p.merchantRef, p.id);
    return {
      document: toDocumentView(document),
      url: url.url,
      expiresAt: url.expiresAt.toISOString(),
    };
  }

  @Post(':merchantRef/documents/:id/verify')
  @HttpCode(200)
  @RequirePermission('kyc:review')
  @Audited('kyc.document.verified', 'kyc_document')
  @ApiOperation({ summary: 'Verify or reject one document' })
  @ApiEnvelopedResponses({ 200: documentViewResultSchema.shape.document })
  async verifyDocument(
    @Param() p: DocumentParamDto,
    @Body() body: VerifyDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    if (body.decision === 'reject' && !body.reason) {
      throw new AppError('VALIDATION_FAILED', {
        details: { fields: [{ path: 'reason', message: 'is required to reject a document' }] },
      });
    }
    return toDocumentView(await this.documents.review(p.merchantRef, p.id, body, staff.userId));
  }
}
