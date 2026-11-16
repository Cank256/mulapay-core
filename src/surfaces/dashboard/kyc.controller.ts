/**
 * `/dashboard/v1/kyc` (spec 7.2): the merchant's KYC status and requirements, its business
 * details and directors, document upload (presign, then confirm) and submission.
 *
 * Merchant-bound: the session names the merchant, and every service call takes it from the
 * principal. Documents are never uploaded through core: `presign` returns a URL for the object
 * store and `confirm` checks what arrived. `profile` and `parties` are additions to spec 7.2,
 * which lists no way to enter registration details or directors.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { KycDataService } from '../../modules/kyc/kyc-data.service';
import { KycDocumentsService } from '../../modules/kyc/kyc-documents.service';
import { KycStatusService } from '../../modules/kyc/kyc-status.service';
import { KycSubmissionService } from '../../modules/kyc/kyc-submission.service';
import { toDocumentView } from '../../modules/kyc/kyc.views';
import {
  confirmBodySchema,
  documentIdParamSchema,
  documentViewSchema,
  kycStatusSchema,
  levelQuerySchema,
  okSchema,
  partyBodySchema,
  partyListSchema,
  partyViewSchema,
  presignBodySchema,
  presignResultSchema,
  profileBodySchema,
  profileViewSchema,
  requirementsResultSchema,
  submitBodySchema,
  submitResultSchema,
} from '../shared/kyc.schemas';

class LevelDto extends createZodDto(levelQuerySchema) {}
class ProfileDto extends createZodDto(profileBodySchema) {}
class PartyDto extends createZodDto(partyBodySchema) {}
class SubmitDto extends createZodDto(submitBodySchema) {}
class PresignDto extends createZodDto(presignBodySchema) {}
class ConfirmDto extends createZodDto(confirmBodySchema) {}
class DocumentParamDto extends createZodDto(documentIdParamSchema) {}
class PartyParamDto extends createZodDto(documentIdParamSchema) {}

@ApiTags('KYC')
@Controller('kyc')
export class DashboardKycController {
  constructor(
    private readonly status: KycStatusService,
    private readonly data: KycDataService,
    private readonly documents: KycDocumentsService,
    private readonly submission: KycSubmissionService
  ) {}

  @Get()
  @RequirePermission('kyc:view')
  @ApiOperation({
    summary: 'KYC status, what is missing, the documents uploaded and the limits in force',
  })
  @ApiEnvelopedResponses({ 200: kycStatusSchema })
  get(@CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.status.view(user.merchant.id);
  }

  @Get('requirements')
  @RequirePermission('kyc:view')
  @ApiOperation({
    summary: 'What the merchant must provide for a level',
    description:
      'Resolved from the requirements data for the merchant’s country and business type. ' +
      '`level` defaults to the next level the merchant can apply for.',
  })
  @ApiEnvelopedResponses({ 200: requirementsResultSchema })
  async requirements(@Query() q: LevelDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const view = await this.status.view(user.merchant.id, q.level);
    return { targetLevel: view.targetLevel, requirements: view.requirements };
  }

  @Get('profile')
  @RequirePermission('kyc:view')
  @ApiOperation({ summary: 'The business details given for KYC (TIN as its last four characters)' })
  @ApiEnvelopedResponses({ 200: profileViewSchema })
  profile(@CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.data.profileView(user.merchant.id);
  }

  @Put('profile')
  @RequirePermission('kyc:submit')
  @Audited('kyc.profile.updated', 'merchant_profile')
  @ApiOperation({ summary: 'Set the business details used for KYC' })
  @ApiEnvelopedResponses({ 200: profileViewSchema })
  updateProfile(@Body() body: ProfileDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.data.updateProfile(scopeOfMerchantUser(user, 'live'), body);
  }

  @Get('parties')
  @RequirePermission('kyc:view')
  @ApiOperation({ summary: 'Directors and beneficial owners given for KYC' })
  @ApiEnvelopedResponses({ 200: partyListSchema })
  async parties(@CurrentMerchantUser() user: MerchantUserPrincipal) {
    return { items: await this.data.listParties(user.merchant.id) };
  }

  @Post('parties')
  @RequirePermission('kyc:submit')
  @Audited('kyc.party.added', 'kyc_party')
  @ApiOperation({ summary: 'Add a director or a beneficial owner' })
  @ApiEnvelopedResponses({ 201: partyViewSchema })
  addParty(@Body() body: PartyDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.data.addParty(scopeOfMerchantUser(user, 'live'), body);
  }

  @Delete('parties/:id')
  @HttpCode(200)
  @RequirePermission('kyc:submit')
  @Audited('kyc.party.removed', 'kyc_party')
  @ApiOperation({ summary: 'Remove a director or a beneficial owner' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async removeParty(@Param() p: PartyParamDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    await this.data.removeParty(scopeOfMerchantUser(user, 'live'), p.id);
    return { ok: true as const };
  }

  @Post('submit')
  @HttpCode(200)
  @RequirePermission('kyc:submit')
  @Audited('kyc.submitted', 'kyc_profile')
  @ApiOperation({
    summary: 'Submit KYC for review',
    description:
      'Needs everything mandatory that the merchant can supply for the level. A draft merchant ' +
      'becomes `pending_kyc`. Screening starts in the background.',
  })
  @ApiEnvelopedResponses({ 200: submitResultSchema })
  submit(@Body() body: SubmitDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.submission.submit(scopeOfMerchantUser(user, 'live'), body.level);
  }

  @Post('documents/presign')
  @HttpCode(200)
  @RequirePermission('kyc:submit')
  @Audited('kyc.document.upload_requested', 'kyc_document')
  @ApiOperation({
    summary: 'Get a presigned URL to upload one document',
    description:
      'PDF, JPEG or PNG, at most 10 MB. Upload with an HTTP PUT of the file, sending exactly ' +
      'the headers returned, then call `POST /kyc/documents` with the same values. Core never ' +
      'receives the file; the file type is checked from its first bytes, not its name.',
  })
  @ApiEnvelopedResponses({ 200: presignResultSchema })
  presign(@Body() body: PresignDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return this.documents.presign(scopeOfMerchantUser(user, 'live'), body);
  }

  @Post('documents')
  @RequirePermission('kyc:submit')
  @Audited('kyc.document.uploaded', 'kyc_document')
  @ApiOperation({ summary: 'Confirm an upload: core checks the object and records the document' })
  @ApiEnvelopedResponses({ 201: documentViewSchema })
  async confirm(@Body() body: ConfirmDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    return toDocumentView(
      await this.documents.confirm(scopeOfMerchantUser(user, 'live'), user.userId, body)
    );
  }

  @Delete('documents/:id')
  @HttpCode(200)
  @RequirePermission('kyc:submit')
  @Audited('kyc.document.removed', 'kyc_document')
  @ApiOperation({ summary: 'Remove a document that has not been verified' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async remove(@Param() p: DocumentParamDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    await this.documents.remove(scopeOfMerchantUser(user, 'live'), p.id);
    return { ok: true as const };
  }
}
