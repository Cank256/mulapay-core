/**
 * What each provider can do through the gateway, as the gateway itself enforces it.
 *
 * Spec 17 rule 3: for gateway behaviour the gateway wins. The gateway keeps two lists that
 * disagree with each other and with spec 3.3 (docs/GATEWAY_INTEGRATION.md): the provider
 * registry (`config/provider-registry.ts`) and the request validator that actually rejects
 * requests (`utils/provider-validation.ts`). Core must never send what either refuses, so
 * `currencies` below is the intersection of the two. Where the spec lists a currency that
 * the gateway rejects (Airtel MWK, Flutterwave RWF, ZMW, XOF, XAF), core refuses it too,
 * before the gateway is called (spec 3.3).
 *
 * Amount limits are the validator's, in major units of the request currency.
 */
import type { CurrencyCode } from '../../common/money/currency-codes';
import {
  PAYMENT_PROVIDERS,
  type PaymentProvider,
} from '../../modules/payments/domain/payment-event';
export type PartyIdType = 'MSISDN' | 'EMAIL';
export type ProviderOperation = 'collection' | 'disbursement' | 'refund';
export interface ProviderCapabilities {
  readonly currencies: readonly CurrencyCode[];
  readonly partyIdTypes: readonly PartyIdType[];
  readonly minAmountMajor: bigint;
  readonly maxAmountMajor: bigint;
  readonly operations: Readonly<Record<ProviderOperation, boolean>>;
}
export const PROVIDER_CAPABILITIES: Readonly<Record<PaymentProvider, ProviderCapabilities>> = {
  mtn: {
    // Registry: UGX GHS XOF XAF ZMW. Validator: UGX EUR GHS ZMW XOF XAF. Intersection:
    currencies: ['UGX', 'GHS', 'ZMW', 'XOF', 'XAF'],
    partyIdTypes: ['MSISDN'],
    minAmountMajor: 1n,
    maxAmountMajor: 5_000_000n,
    // capabilities.refund is false for MTN (spec 6.4).
    operations: { collection: true, disbursement: true, refund: false },
  },
  airtel: {
    // Registry: UGX KES TZS RWF ZMW MWK NGN. Validator: UGX KES TZS RWF ZMW NGN XOF XAF.
    currencies: ['UGX', 'KES', 'TZS', 'RWF', 'ZMW', 'NGN'],
    partyIdTypes: ['MSISDN'],
    minAmountMajor: 1n,
    maxAmountMajor: 5_000_000n,
    operations: { collection: true, disbursement: true, refund: true },
  },
  flutterwave: {
    // Registry: NGN GHS KES UGX TZS ZAR RWF ZMW XOF XAF USD EUR GBP. Validator: NGN GHS KES
    // UGX ZAR TZS USD EUR GBP. Intersection:
    currencies: ['NGN', 'GHS', 'KES', 'UGX', 'TZS', 'ZAR', 'USD', 'EUR', 'GBP'],
    partyIdTypes: ['EMAIL', 'MSISDN'],
    minAmountMajor: 1n,
    maxAmountMajor: 10_000_000n,
    operations: { collection: true, disbursement: true, refund: true },
  },
};
export function providerSupportsCurrency(provider: PaymentProvider, currency: string): boolean {
  return (PROVIDER_CAPABILITIES[provider].currencies as readonly string[]).includes(currency);
}
export function providerSupports(provider: PaymentProvider, operation: ProviderOperation): boolean {
  return PROVIDER_CAPABILITIES[provider].operations[operation];
}
export function providersFor(operation: ProviderOperation, currency: string): PaymentProvider[] {
  return PAYMENT_PROVIDERS.filter(
    (p) => providerSupports(p, operation) && providerSupportsCurrency(p, currency)
  );
}
