import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../test/support/fixed-clock';
import { uuidTimeBound } from '../../modules/lifecycle/domain/retention-policy';
import type { Executor } from '../db/database.types';
import type { OutboxRepository } from './outbox.repository';
import { OutboxService } from './outbox.service';

/**
 * The outbox purge deletes `id < uuidTimeBound(cutoff)` (see `purgePublishedOutbox`). That is only
 * correct while every outbox id is a UUID v7 whose time prefix is the row's `created_at`. If ids
 * stopped being time-ordered, the purge would silently delete nothing (P9-V14). These tests fail
 * first.
 */
describe('outbox id ordering', () => {
  it('writes an id inside the millisecond of created_at', async () => {
    const clock = new FixedClock('2031-06-15T10:00:00.123Z');
    const inserted: { id: string; createdAt: Date }[] = [];
    const repository = {
      insert: (_tx: Executor, row: { id: string; createdAt: Date }) => {
        inserted.push(row);
        return Promise.resolve(true);
      },
    } as unknown as OutboxRepository;
    const service = new OutboxService(repository, clock);
    for (let i = 0; i < 20; i += 1) {
      await service.enqueue({} as Executor, {
        aggregateType: 'probe',
        aggregateId: '1',
        eventType: 'probe.created',
        payload: {},
        dedupeKey: `k-${i}`,
      });
      clock.advanceBy(7);
    }
    expect(inserted).toHaveLength(20);
    for (const row of inserted) {
      const from = uuidTimeBound(row.createdAt);
      const to = uuidTimeBound(new Date(row.createdAt.getTime() + 1));
      expect(row.id >= from && row.id < to, `${row.id} outside [${from}, ${to})`).toBe(true);
    }
    const ids = inserted.map((row) => row.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('has exactly one insert path into core.outbox', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/\.insert\(\s*outbox\s*\)/.test(text) || /insert\s+into\s+core\.outbox/i.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(join(__dirname, '..', '..'));
    expect(offenders.map((p) => p.split('/src/')[1])).toEqual([
      'common/outbox/outbox.repository.ts',
    ]);
  });
});
