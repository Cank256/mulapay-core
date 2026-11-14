/**
 * The consumer's singleton guarantee (spec section 4.1): exactly one holder of
 * pg_try_advisory_lock(hashtext(name)), and loss of the lock is detected.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import pino from 'pino';
import { describe, expect, inject, it, vi } from 'vitest';
import { tryAcquireSingletonLock } from '../../src/common/db/advisory-lock';
import { GATEWAY_CONSUMER_LOCK } from '../../src/consumers/gateway-events/constants';

const logger = pino({ level: 'silent' });

function options(
  lockName: string,
  onLost = vi.fn(),
  applicationName = `lock-test-${randomUUID()}`
) {
  return {
    connectionString: inject('databaseUrls').rw,
    lockName,
    applicationName,
    logger,
    onLost,
    verifyIntervalMs: 200,
  };
}

describe('singleton advisory lock', () => {
  it('admits exactly one holder at a time', async () => {
    const name = `test:${randomUUID()}`;
    const first = await tryAcquireSingletonLock(options(name));
    expect(first).not.toBeNull();

    const second = await tryAcquireSingletonLock(options(name));
    expect(second).toBeNull();

    await first?.release();
    const third = await tryAcquireSingletonLock(options(name));
    expect(third).not.toBeNull();
    await third?.release();
  });

  it('uses the spec lock name for the gateway consumer', async () => {
    expect(GATEWAY_CONSUMER_LOCK).toBe('core:gateway-event-consumer');
    const lock = await tryAcquireSingletonLock(options(GATEWAY_CONSUMER_LOCK));
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it('reports loss when the lock connection is terminated', async () => {
    const onLost = vi.fn();
    const applicationName = `lock-test-${randomUUID()}`;
    const lock = await tryAcquireSingletonLock(
      options(`test:${randomUUID()}`, onLost, applicationName)
    );
    expect(lock).not.toBeNull();

    const admin = new Client({ connectionString: inject('databaseUrls').superuser });
    await admin.connect();
    await admin.query(
      'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1',
      [applicationName]
    );
    await admin.end();

    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await lock?.release();
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it('does not report loss on a deliberate release', async () => {
    const onLost = vi.fn();
    const lock = await tryAcquireSingletonLock(options(`test:${randomUUID()}`, onLost));
    await lock?.release();
    await new Promise((r) => setTimeout(r, 400));
    expect(onLost).not.toHaveBeenCalled();
  });
});
