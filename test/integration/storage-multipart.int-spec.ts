/**
 * Streaming uploads to object storage (spec 6.12): a file larger than a part goes up as a
 * multipart upload without being held whole, a failure leaves no partial object, and the
 * checksum returned is the one of the bytes written.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageUnavailableError } from '../../src/integrations/storage/object-storage.port';
import { S3ObjectStorage } from '../../src/integrations/storage/s3-object-storage';
import { FixedClock } from '../support/fixed-clock';
import { FAKE_S3, startFakeS3, type FakeS3 } from '../support/fake-s3';
import { testConfig } from '../support/test-env';

let s3: FakeS3;
let storage: S3ObjectStorage;
const MIB = 1024 * 1024;

beforeAll(async () => {
  s3 = await startFakeS3();
  storage = new S3ObjectStorage(testConfig(s3.config()), new FixedClock(new Date()));
});
afterAll(async () => {
  await s3?.close();
});

async function* chunks(parts: Buffer[], failAfter?: number): AsyncGenerator<Buffer> {
  let i = 0;
  for (const part of parts) {
    if (failAfter !== undefined && i === failAfter) throw new Error('source failed');
    yield part;
    i += 1;
  }
}
const key = (name: string) => `${FAKE_S3.reports}/streams/${name}`;

describe('putStream', () => {
  it('stores a small file with one request', async () => {
    const body = randomBytes(10_000);
    const before = s3.requests.length;
    const result = await storage.putStream(
      'reports',
      'streams/small.csv',
      chunks([body.subarray(0, 4000), body.subarray(4000)]),
      'text/csv',
      { partBytes: 5 * MIB }
    );
    expect(result).toEqual({
      sizeBytes: 10_000,
      sha256Hex: createHash('sha256').update(body).digest('hex'),
    });
    expect(s3.objects.get(key('small.csv'))?.body.equals(body)).toBe(true);
    expect(s3.requests.slice(before).map((r) => r.method)).toEqual(['PUT']);
  });

  it('uploads a large file in parts, holding one part at a time', async () => {
    const parts = Array.from({ length: 12 }, () => randomBytes(MIB));
    const whole = Buffer.concat(parts);
    s3.maxBodyBytes = 0;
    const result = await storage.putStream(
      'reports',
      'streams/large.csv',
      chunks(parts),
      'text/csv',
      { partBytes: 5 * MIB }
    );
    expect(result.sizeBytes).toBe(12 * MIB);
    expect(result.sha256Hex).toBe(createHash('sha256').update(whole).digest('hex'));
    expect(s3.objects.get(key('large.csv'))?.body.equals(whole)).toBe(true);
    expect(s3.objects.get(key('large.csv'))?.encryption).toBe('AES256');
    // 5 + 5 + 2 MiB: the biggest request was a part, not the file.
    expect(s3.maxBodyBytes).toBeLessThanOrEqual(5 * MIB);
    expect(s3.uploads.size).toBe(0);
  });

  it('aborts the upload when the source fails, leaving no object and no open upload', async () => {
    const parts = Array.from({ length: 10 }, () => randomBytes(MIB));
    await expect(
      storage.putStream('reports', 'streams/broken.csv', chunks(parts, 8), 'text/csv', {
        partBytes: 5 * MIB,
      })
    ).rejects.toThrow('source failed');
    expect(s3.objects.has(key('broken.csv'))).toBe(false);
    expect(s3.uploads.size).toBe(0);
  });

  it('reports an unavailable store as such', async () => {
    s3.failWith = 503;
    try {
      await expect(
        storage.putStream('reports', 'streams/down.csv', chunks([randomBytes(10)]), 'text/csv', {
          partBytes: 5 * MIB,
        })
      ).rejects.toBeInstanceOf(StorageUnavailableError);
    } finally {
      s3.failWith = null;
    }
  });
});
