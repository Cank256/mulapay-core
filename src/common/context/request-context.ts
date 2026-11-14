/**
 * Per-request context carried through async calls with AsyncLocalStorage, so every log
 * line written while handling a request carries its requestId and surface without passing
 * them through every function signature.
 *
 * Actor fields are filled in by the authentication guards (Phase 1 and Phase 5).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Surface } from '../http/surface';

export interface RequestContextStore {
  readonly requestId: string;
  readonly surface: Surface;
  merchantId?: string;
  actorType?: 'user' | 'api_key' | 'system' | 'job';
  actorId?: string;
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
