/**
 * Redis connections. Redis holds caches, rate-limit counters, locks and queues; it is
 * never a source of financial truth (spec section 2 and AGENTS.md).
 *
 * Connections are lazy so constructing the application (for example to export OpenAPI
 * documents) opens no sockets.
 */
import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/configuration';
import { toLoggableError } from '../logging/redaction';

/**
 * - commands:       cache, limits, health; fails fast when Redis is unavailable
 * - queue-producer: BullMQ Queue instances
 * - queue-worker:   BullMQ Worker instances; must allow unlimited retries per request
 */
export type RedisPurpose = 'commands' | 'queue-producer' | 'queue-worker';

type RedisSettings = Pick<AppConfig, 'REDIS_URL' | 'REDIS_TLS' | 'APP_ROLE'>;

export function redisOptions(settings: RedisSettings, purpose: RedisPurpose): RedisOptions {
  return {
    lazyConnect: true,
    connectionName: `mulapay-core:${settings.APP_ROLE}:${purpose}`,
    connectTimeout: 5000,
    maxRetriesPerRequest: purpose === 'queue-worker' ? null : 1,
    enableReadyCheck: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    ...(settings.REDIS_TLS ? { tls: {} } : {}),
  };
}

export function createRedisClient(
  settings: RedisSettings,
  purpose: RedisPurpose,
  logger: Logger
): Redis {
  const client = new Redis(settings.REDIS_URL, redisOptions(settings, purpose));
  client.on('error', (error) => {
    logger.warn({ purpose, err: toLoggableError(error) }, 'redis connection error');
  });
  return client;
}

/** Closes gracefully, falling back to a hard disconnect if QUIT cannot be sent. */
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
