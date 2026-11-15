import { describe, expect, it } from 'vitest';
import { chainHash, GENESIS_HASH, type ChainedRow } from '../../common/audit/audit-chain';
import { FixedClock } from '../../../test/support/fixed-clock';
import type { AuditLogsRepository } from './audit-logs.repository';
import type { MerchantsRepository } from '../merchants/merchants.repository';
import { AuditLogsService } from './audit-logs.service';

function buildChain(count: number): ChainedRow[] {
  const rows: ChainedRow[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= count; seq++) {
    const fields = {
      seq,
      actorType: 'system',
      actorId: null,
      actorLabel: null,
      merchantId: null,
      action: 'test',
      resourceType: 'test',
      resourceId: null,
      before: null,
      after: { n: seq },
      changedFields: ['n'],
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
      surface: null,
      outcome: 'success',
      createdAt: new Date(seq * 1000),
    };
    const hash = chainHash(prev, fields);
    rows.push({ ...fields, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

/** A stub repository over an in-memory chain; `appendDuringWalk` simulates concurrent writes. */
function service(
  rows: ChainedRow[],
  head: { lastSeq: number; lastHash: string },
  appendDuringWalk = 0
) {
  let extra = appendDuringWalk;
  const repo = {
    head: async () => ({ id: 1, ...head }),
    batch: async (after: number, upTo: number, limit: number) => {
      if (extra > 0) {
        extra = 0;
        rows.push(...buildChain(rows.length + appendDuringWalk).slice(rows.length));
      }
      return rows.filter((r) => r.seq > after && r.seq <= upTo).slice(0, limit);
    },
  } as unknown as AuditLogsRepository;
  return new AuditLogsService(repo, {} as MerchantsRepository, new FixedClock());
}

describe('AuditLogsService.verify', () => {
  it('accepts an intact chain whose head matches', async () => {
    const rows = buildChain(5);
    const result = await service(rows, { lastSeq: 5, lastHash: rows[4]!.hash }).verify();
    expect(result).toEqual({ valid: true, checked: 5, lastSeq: 5, firstBreak: null });
  });

  it('ignores rows appended after the head snapshot', async () => {
    const rows = buildChain(3);
    const result = await service(rows, { lastSeq: 3, lastHash: rows[2]!.hash }, 2).verify();
    expect(result).toMatchObject({ valid: true, checked: 3 });
  });

  it('reports deleted newest rows and a forged head', async () => {
    const rows = buildChain(4);
    const truncated = rows.slice(0, 2);
    expect(
      (await service(truncated, { lastSeq: 4, lastHash: rows[3]!.hash }).verify()).firstBreak
    ).toEqual({
      seq: 4,
      reason: 'head_mismatch',
    });
    expect(
      (await service(rows, { lastSeq: 4, lastHash: 'f'.repeat(64) }).verify()).firstBreak?.reason
    ).toBe('head_mismatch');
  });

  it('reports the first edited row', async () => {
    const rows = buildChain(4);
    rows[2] = { ...rows[2]!, after: { n: 99 } };
    expect(
      (await service(rows, { lastSeq: 4, lastHash: rows[3]!.hash }).verify()).firstBreak
    ).toEqual({
      seq: 3,
      reason: 'hash_mismatch',
    });
  });

  it('is valid for an empty chain', async () => {
    expect(await service([], { lastSeq: 0, lastHash: GENESIS_HASH }).verify()).toMatchObject({
      valid: true,
      checked: 0,
    });
  });
});
