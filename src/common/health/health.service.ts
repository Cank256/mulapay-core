/**
 * Readiness checks (spec section 7.4): DB rw, DB ro, Redis, gateway. All run in parallel
 * and each is bounded by CHECK_TIMEOUT_MS so the probe answers promptly when a
 * dependency hangs.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { GatewayHealthClient } from '../../integrations/gateway/gateway-health.client';
import type { DatabasePools } from '../db/pools';
import { DB_POOLS } from '../db/tokens';
import { toLoggableError } from '../logging/redaction';
import { REDIS } from '../redis/redis.module';
import { ROOT_LOGGER } from '../tokens';

export const CHECK_TIMEOUT_MS = 2000;

export type CheckStatus = 'up' | 'down' | 'not_configured';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, CheckStatus>>;
}

async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} check timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB_POOLS) private readonly pools: DatabasePools,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly gateway: GatewayHealthClient
  ) {}

  async checkReadiness(): Promise<ReadinessReport> {
    const checks: Record<string, () => Promise<CheckStatus>> = {
      database_rw: async () => {
        await this.pools.rw.query('select 1');
        return 'up';
      },
      database_ro: async () => {
        await this.pools.ro.query('select 1');
        return 'up';
      },
      redis: async () => ((await this.redis.ping()) === 'PONG' ? 'up' : 'down'),
      gateway: () => this.gateway.checkReady(CHECK_TIMEOUT_MS),
    };

    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]): Promise<[string, CheckStatus]> => {
        try {
          return [name, await withTimeout(check(), CHECK_TIMEOUT_MS, name)];
        } catch (error) {
          this.logger.warn({ check: name, err: toLoggableError(error) }, 'readiness check failed');
          return [name, 'down'];
        }
      })
    );
    const result = Object.fromEntries(entries);
    // not_configured is allowed only outside production; env validation enforces that.
    const ready = entries.every(([, status]) => status !== 'down');
    if (!ready) this.logger.warn({ checks: result }, 'service not ready');
    return { ready, checks: result };
  }
}
