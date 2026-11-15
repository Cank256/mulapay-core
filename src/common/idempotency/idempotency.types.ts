/** Types shared by the idempotency service, interceptor and the routes that use them. */
import type { Transaction } from '../db/database.types';

/** Metadata key set by `@Idempotent(operation)` and read by the interceptor. */
export const IDEMPOTENT_OPERATION = Symbol('IDEMPOTENT_OPERATION');

/** What identifies one idempotent request (spec 8.2). The merchant comes from the principal. */
export interface IdempotencyContext {
  /** The operation, `{domain}.{action}`, for example `payments.create`. */
  readonly operation: string;
  /** The caller's `Idempotency-Key`: 1 to 255 printable ASCII characters. */
  readonly key: string;
  /** `sha256(canonicalJson(body) + method + path)`, hex. */
  readonly fingerprint: string;
}

/** What the work of an idempotent request produces: the response to store and to replay. */
export interface IdempotentWork<T> {
  readonly statusCode: number;
  /** JSON-serialisable data, without the envelope. */
  readonly body: T;
  /**
   * What to store for replay when it must differ from `body`: a credential shown once (a
   * client secret) is returned to the caller but never written to the database in clear.
   */
  readonly stored?: T;
  /**
   * Runs last in the same transaction, after the response has been stored. The audit row
   * goes here so it is the final statement and holds the chain-head lock the shortest time.
   */
  readonly finalize?: (tx: Transaction) => Promise<void>;
}

/**
 * The result of `IdempotencyService.run`. A controller returns it as is; the interceptor
 * unwraps it to the body and sets `Idempotency-Replayed` on a replay.
 */
export class IdempotentResponse<T> {
  constructor(
    readonly statusCode: number,
    readonly body: T,
    readonly replayed: boolean
  ) {}
}

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: IdempotencyContext;
  }
}
