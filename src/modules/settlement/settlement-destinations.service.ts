/**
 * Where a merchant's settlements are paid (spec 6.9 "the merchant's settlement
 * destination"). One active destination per merchant and currency, stored encrypted
 * (AES-256-GCM, spec 11); screens and reports show only a masked form.
 *
 * `fingerprint` is an HMAC of the details. A batch records it when it is submitted, and
 * release refuses if the active destination no longer has it: a destination changed after
 * approval cannot receive money the approver never saw it go to (spec 6.3, "new destination").
 *
 * Destinations are mobile-money wallets: the gateway's party types are MSISDN, EMAIL and
 * PARTY_CODE, so a bank account has no wire form in the documented contract.
 */
import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { sha256Hex } from '../../common/crypto/crypto';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import type { Executor } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import {
  providerSupports,
  providerSupportsCurrency,
} from '../../integrations/gateway/provider-capabilities';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { isPaymentProvider, type PaymentProvider } from '../payments/domain/payment-event';
import {
  SettlementDestinationsRepository,
  type DestinationRow,
} from './settlement-destinations.repository';

const MSISDN = /^\+[1-9][0-9]{7,14}$/;

export interface DestinationInput {
  readonly currency: string;
  readonly provider: string;
  /** International form with a `+`, for example `+256700000000`. */
  readonly msisdn: string;
}

export interface Payee {
  readonly partyIdType: 'MSISDN';
  readonly partyId: string;
}

function invalid(reason: string): AppError {
  return new AppError('SETTLEMENT_DESTINATION_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

/** `+256•••••789`: country code and last three digits. */
export function maskMsisdn(msisdn: string): string {
  return `${msisdn.slice(0, 4)}${'•'.repeat(Math.max(0, msisdn.length - 7))}${msisdn.slice(-3)}`;
}

@Injectable()
export class SettlementDestinationsService {
  constructor(
    private readonly destinations: SettlementDestinationsRepository,
    private readonly merchants: MerchantsRepository,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Replaces the merchant's active destination for the currency. */
  async set(
    merchantRef: string,
    input: DestinationInput,
    actorId: string
  ): Promise<DestinationRow> {
    const provider = this.validate(input);
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const merchant = await this.merchants.lockByRef(tx, merchantRef);
      if (!merchant) throw new AppError('NOT_FOUND');
      if (merchant.status === 'closed') throw invalid('merchant_closed');
      const previous = await this.destinations.findActive(tx, merchant.id, input.currency);
      if (previous) await this.destinations.retire(tx, previous.id, now);
      const id = uuidv7(now);
      const row = await this.destinations.insert(tx, {
        id,
        ref: publicId('settlementDestination', now),
        merchantId: merchant.id,
        currency: input.currency,
        provider,
        detailsEnc: this.encryption.encrypt(
          JSON.stringify({ partyIdType: 'MSISDN', partyId: input.msisdn }),
          `settlement_destinations.details:${id}`
        ),
        display: maskMsisdn(input.msisdn),
        fingerprint: this.fingerprint(provider, input.currency, input.msisdn),
        createdBy: `user:${actorId}`,
        createdAt: now,
      });
      await this.audit.record(tx, {
        action: 'settlement.destination.set',
        resourceType: 'settlement_destination',
        resourceId: row.ref,
        merchantId: merchant.id,
        before: previous ? { destination: previous.ref, display: previous.display } : null,
        after: { destination: row.ref, provider, currency: row.currency, display: row.display },
      });
      return row;
    });
  }

  findActive(tx: Executor, merchantId: string, currency: string) {
    return this.destinations.findActive(tx, merchantId, currency);
  }

  findById(tx: Executor, id: string) {
    return this.destinations.findById(tx, id);
  }

  listForMerchant(merchantRef: string): Promise<DestinationRow[]> {
    return this.destinations.listForMerchantRef(merchantRef);
  }

  /** Decrypts the payee for the gateway call. Never logged, never returned by the API. */
  payee(destination: DestinationRow): Payee {
    const parsed = JSON.parse(
      this.encryption.decrypt(
        destination.detailsEnc,
        `settlement_destinations.details:${destination.id}`
      )
    ) as Payee;
    return parsed;
  }

  /** Checks that the destination can still receive a payout in `currency` through its provider. */
  assertUsable(destination: DestinationRow, currency: string): PaymentProvider {
    if (!isPaymentProvider(destination.provider)) throw invalid('provider');
    if (
      destination.status !== 'active' ||
      destination.currency !== currency ||
      !providerSupports(destination.provider, 'disbursement') ||
      !providerSupportsCurrency(destination.provider, currency)
    ) {
      throw invalid('provider_cannot_pay_this_currency');
    }
    return destination.provider;
  }

  private fingerprint(provider: string, currency: string, msisdn: string): string {
    const canonical = `${provider}|${currency}|MSISDN|${msisdn}`;
    return this.config.PII_HMAC_PEPPER
      ? createHmac('sha256', this.config.PII_HMAC_PEPPER).update(canonical).digest('hex')
      : sha256Hex(`settlement-destination:${canonical}`);
  }

  private validate(input: DestinationInput): PaymentProvider {
    if (!isSupportedCurrency(input.currency)) throw invalid('currency');
    if (!isPaymentProvider(input.provider)) throw invalid('provider');
    if (!MSISDN.test(input.msisdn)) throw invalid('msisdn');
    if (
      !providerSupports(input.provider, 'disbursement') ||
      !providerSupportsCurrency(input.provider, input.currency)
    ) {
      throw invalid('provider_cannot_pay_this_currency');
    }
    return input.provider;
  }
}
