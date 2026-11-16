/**
 * The gateway calls Phase 6 needs, behind one interface (spec 3.2, rules "external
 * integrations sit behind explicit interfaces" and "no coupling to gateway internals").
 *
 *   submitDisbursement  settlement payout, `POST /api/v1/payment/:providerId/disbursement`
 *   findByExternalId    `GET /api/v1/transaction/by-external-id/:externalId`
 *   listOperations      `GET /api/v1/transaction` (newest first, offset pagination)
 *   getBalance          `GET /api/v1/payment/:providerId/balance?accountType=`
 *
 * Every result is a value that names the ambiguity explicitly: a caller cannot mistake "the
 * gateway did not answer" for "nothing happened". Core never retries a disbursement with a
 * new `externalId` (spec 3.4, 3.5); the full client with circuit breaking is Phase 3 and
 * will implement this interface.
 */
import type { PaymentProvider } from '../../modules/payments/domain/payment-event';

export const GATEWAY_OPERATIONS = Symbol('GATEWAY_OPERATIONS');

export type GatewayStatus =
  'pending' | 'unknown' | 'successful' | 'failed' | 'expired' | 'cancelled';
export type GatewayOperationType = 'collection' | 'disbursement' | 'refund';

export function isTerminalGatewayStatus(status: GatewayStatus): boolean {
  return (
    status === 'successful' || status === 'failed' || status === 'expired' || status === 'cancelled'
  );
}

export interface GatewayOperation {
  readonly providerId: string;
  readonly operationType: GatewayOperationType;
  readonly referenceId: string | null;
  readonly externalId: string;
  readonly status: GatewayStatus;
  /** Exactly as the gateway sent it (`"1000.0000"`): compare numerically. */
  readonly amount: string;
  readonly currency: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DisbursementRequest {
  readonly environment: 'test' | 'live';
  readonly providerId: PaymentProvider;
  /** `po_{ULID}`: the same business payout always has the same key (spec 3.4). */
  readonly externalId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly payee: { readonly partyIdType: 'MSISDN' | 'EMAIL'; readonly partyId: string };
  readonly metadata: {
    readonly merchantId: string;
    readonly environment: 'live';
    readonly coreTransactionId: string;
  };
}

export type DisbursementResult =
  /** 201, or 200 for an `externalId` the gateway already knows. */
  | {
      readonly kind: 'accepted';
      readonly duplicate: boolean;
      readonly referenceId: string;
      readonly status: GatewayStatus;
    }
  /** The gateway refused before creating an operation: no money moved. */
  | {
      readonly kind: 'rejected';
      readonly reason: 'validation' | 'conflict' | 'unauthorized' | 'provider_unavailable';
      readonly httpStatus: number;
    }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number | null }
  /** 504, a timeout, a 5xx or an unreadable answer: the outcome is unknown (spec 3.5). */
  | {
      readonly kind: 'ambiguous';
      readonly referenceId: string | null;
      readonly httpStatus: number | null;
    };

export type OperationLookup =
  | { readonly kind: 'found'; readonly operation: GatewayOperation }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type OperationPage =
  | {
      readonly kind: 'ok';
      readonly operations: readonly GatewayOperation[];
      readonly total: number;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type GatewayBalance =
  | { readonly kind: 'ok'; readonly availableMinor: bigint; readonly currency: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export type BalanceAccountType = 'collection' | 'disbursement';

export interface GatewayOperationsPort {
  /** Sends a payout. Never throws for an outcome; throws only for a programming error. */
  submitDisbursement(request: DisbursementRequest): Promise<DisbursementResult>;
  findByExternalId(
    externalId: string,
    filter?: { providerId?: string; operationType?: GatewayOperationType }
  ): Promise<OperationLookup>;
  listOperations(query: {
    operationType?: GatewayOperationType;
    providerId?: string;
    limit: number;
    offset: number;
  }): Promise<OperationPage>;
  /** The provider balance in minor units of `currency`. */
  getBalance(
    providerId: PaymentProvider,
    accountType: BalanceAccountType,
    currency: string
  ): Promise<GatewayBalance>;
}
