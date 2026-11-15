/**
 * Per-request context carried through async calls with AsyncLocalStorage, so every log
 * line written while handling a request carries its requestId and surface without passing
 * them through every function signature.
 *
 * Actor fields are filled in by the authentication guard. `ip` and `userAgent` are set
 * when the request starts and are read by the audit trail; they are never logged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Surface } from '../http/surface';

export type ActorType = 'user' | 'api_key' | 'system' | 'job';

export interface RequestContextStore {
  readonly requestId: string;
  readonly surface: Surface;
  readonly ip?: string;
  readonly userAgent?: string;
  /** Public merchant ref (`mch_...`), safe to log. */
  merchantId?: string;
  actorType?: ActorType;
  /** Public actor ref (`usr_...`, `ak_...`). */
  actorId?: string;
  /** Display label for audit rows (a user's name or a key's name). Not logged. */
  actorLabel?: string;
  /** Number of audit rows written for this request; read by the audit interceptor. */
  auditRows?: number;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export const requestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },
};
