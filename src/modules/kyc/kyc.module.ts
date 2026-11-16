import { Module } from '@nestjs/common';
import { OutboxModule } from '../../common/outbox/outbox.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { AmlModule } from '../aml/aml.module';
import { EventsModule } from '../events/events.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { KycAdminService } from './kyc-admin.service';
import { KycDataRepository } from './kyc-data.repository';
import { KycDataService } from './kyc-data.service';
import { KycDocumentsRepository } from './kyc-documents.repository';
import { KycDocumentsService } from './kyc-documents.service';
import { KycEvidenceService } from './kyc-evidence.service';
import { KycLifecycleService } from './kyc-lifecycle.service';
import { KycProfilesRepository } from './kyc-profiles.repository';
import { KycRequirementsRepository } from './kyc-requirements.repository';
import { KycRequirementsService } from './kyc-requirements.service';
import { KycReviewService } from './kyc-review.service';
import { KycScreeningRequestedHandler } from './kyc-screening.handler';
import { KycScreeningService } from './kyc-screening.service';
import { KycStatusService } from './kyc-status.service';
import { KycSubmissionService } from './kyc-submission.service';

/**
 * KYC (spec 6.13): levels, requirements as data, documents, submission, review and
 * activation, onboarding screening, expiry and re-verification.
 */
@Module({
  imports: [AmlModule, EventsModule, MerchantsModule, OutboxModule, StorageModule],
  providers: [
    KycProfilesRepository,
    KycDocumentsRepository,
    KycDataRepository,
    KycRequirementsRepository,
    KycRequirementsService,
    KycEvidenceService,
    KycStatusService,
    KycDataService,
    KycDocumentsService,
    KycSubmissionService,
    KycReviewService,
    KycAdminService,
    KycLifecycleService,
    KycScreeningService,
    KycScreeningRequestedHandler,
  ],
  exports: [
    KycAdminService,
    KycDataService,
    KycDocumentsService,
    KycLifecycleService,
    KycRequirementsService,
    KycReviewService,
    KycScreeningRequestedHandler,
    KycScreeningService,
    KycStatusService,
    KycSubmissionService,
  ],
})
export class KycModule {}
