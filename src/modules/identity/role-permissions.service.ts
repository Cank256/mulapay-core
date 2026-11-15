/**
 * Role-to-permission lookups for ability building, read on every authenticated request.
 *
 * Cached in process for 30 seconds (spec 9.2 rule 8). A permission edit clears the cache
 * locally and publishes on `core:authz:roles-changed` so every replica clears its copy
 * without waiting for the TTL. If the subscription is down, the TTL bounds staleness.
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Clock } from '../../common/clock/clock';
import { toLoggableError } from '../../common/logging/redaction';
import { REDIS } from '../../common/redis/redis.module';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { RolesRepository } from './roles.repository';

export const ROLES_CHANGED_CHANNEL = 'core:authz:roles-changed';
const CACHE_TTL_MS = 30_000;

@Injectable()
export class RolePermissionsService implements OnModuleInit, OnApplicationShutdown {
  private cache?: { loadedAt: number; byRole: Map<string, readonly string[]> };
  private subscriber?: Redis;

  constructor(
    private readonly roles: RolesRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  onModuleInit(): void {
    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('message', () => this.invalidateLocal());
    subscriber.on('error', (error) => {
      this.logger.warn({ err: toLoggableError(error) }, 'roles-changed subscriber error');
    });
    subscriber
      .connect()
      .then(() => subscriber.subscribe(ROLES_CHANGED_CHANNEL))
      .catch((error: unknown) => {
        this.logger.warn({ err: toLoggableError(error) }, 'roles-changed subscription failed');
      });
  }

  async onApplicationShutdown(): Promise<void> {
    this.subscriber?.disconnect();
  }

  /** Union of the permissions of `roleKeys`. */
  async permissionsFor(roleKeys: readonly string[]): Promise<string[]> {
    const byRole = await this.load();
    const out = new Set<string>();
    for (const key of roleKeys) for (const p of byRole.get(key) ?? []) out.add(p);
    return [...out];
  }

  invalidateLocal(): void {
    this.cache = undefined;
  }

  /** Clears every replica's cache. Call after the edit has committed. */
  async invalidateAll(): Promise<void> {
    this.invalidateLocal();
    try {
      await this.redis.publish(ROLES_CHANGED_CHANNEL, String(this.clock.now().getTime()));
    } catch (error) {
      this.logger.warn({ err: toLoggableError(error) }, 'roles-changed publish failed');
    }
  }

  private async load(): Promise<Map<string, readonly string[]>> {
    const now = Date.now();
    if (this.cache && now - this.cache.loadedAt < CACHE_TTL_MS) return this.cache.byRole;
    const rows = await this.roles.allRolePermissions();
    const byRole = new Map<string, string[]>();
    for (const row of rows) {
      const list = byRole.get(row.roleKey) ?? [];
      list.push(row.permissionKey);
      byRole.set(row.roleKey, list);
    }
    this.cache = { loadedAt: now, byRole };
    return byRole;
  }
}
