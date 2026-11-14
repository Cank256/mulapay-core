import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB_OPTIONS, QUEUES, QUEUE_DEFINITIONS, jobOptionsFor } from './queue.definitions';
import { deadLetterJobId, isFinalFailure } from './worker-host';

describe('queue definitions', () => {
  it('match the queue table in spec section 8.9', () => {
    expect(Object.fromEntries(QUEUE_DEFINITIONS.map((q) => [q.name, q.concurrency]))).toEqual({
      'outbox-dispatch': 4,
      'webhook-delivery': 32,
      'notification-send': 16,
      'report-generate': 2,
      'settlement-run': 1,
      'aml-screen': 8,
      'statement-match': 2,
      'rollup-aggregate': 2,
      'gateway-chase': 8,
    });
  });

  it('give every job retries with exponential backoff and bounded retention', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThan(1);
    expect(DEFAULT_JOB_OPTIONS.backoff).toMatchObject({ type: 'exponential' });
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toMatchObject({ count: expect.any(Number) });
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toMatchObject({ count: expect.any(Number) });
  });

  it('let a queue override the defaults', () => {
    expect(jobOptionsFor(QUEUES.settlementRun)).toEqual(DEFAULT_JOB_OPTIONS);
    expect(jobOptionsFor({ name: 'x', concurrency: 1, jobOptions: { attempts: 7 } }).attempts).toBe(
      7
    );
  });
});

describe('dead-letter helpers', () => {
  it('treats the last attempt or an unrecoverable error as final', () => {
    const error = new Error('x');
    expect(isFinalFailure({ attemptsMade: 5, opts: { attempts: 5 } }, error)).toBe(true);
    expect(isFinalFailure({ attemptsMade: 2, opts: { attempts: 5 } }, error)).toBe(false);
    expect(isFinalFailure({ attemptsMade: 1, opts: {} }, error)).toBe(true);
    const unrecoverable = Object.assign(new Error('stop'), { name: 'UnrecoverableError' });
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 5 } }, unrecoverable)).toBe(true);
  });

  it('derives a deterministic id BullMQ accepts', () => {
    expect(deadLetterJobId('outbox-dispatch', '42')).toBe('outbox-dispatch.42');
    expect(deadLetterJobId('q', 'repeat:abc:1')).toBe('q.repeat_abc_1');
  });
});
