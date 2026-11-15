import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error';
import { publicId } from '../../../common/ids/ids';
import { MAX_MINOR } from '../../../common/money/minor-units';
import { merchantAccountCode } from '../../accounts/domain/chart-of-accounts';
import {
  ledgerIdempotencyKey,
  MAX_LINES,
  postingFingerprint,
  reverseLines,
  validatePosting,
  type PostingDraft,
  type PostingLineInput,
} from './posting';

const payable = merchantAccountCode('merchant_payable', publicId('merchant'));
const clearing = '1000:provider_clearing:mtn';
const fees = '4000:fee_revenue';

function draft(overrides: Partial<PostingDraft> = {}): PostingDraft {
  return {
    idempotencyKey: ledgerIdempotencyKey('payment', 'evt_1'),
    environment: 'live',
    currency: 'UGX',
    source: 'payment',
    sourceId: 'evt_1',
    merchantId: '018f3c1e-7d2a-7b4c-9e1f-0123456789ab',
    description: 'Collection succeeded',
    lines: [
      { accountCode: clearing, direction: 'debit', amountMinor: 10_000n },
      { accountCode: payable, direction: 'credit', amountMinor: 10_000n },
    ],
    createdBy: { type: 'system', id: 'gateway-consumer' },
    ...overrides,
  };
}

function reasonOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.details?.reason ?? error.code;
    throw error;
  }
  return undefined;
}

describe('validatePosting', () => {
  it('accepts the canonical collection posting (spec 5.5) and applies defaults', () => {
    const lines: PostingLineInput[] = [
      { accountCode: clearing, direction: 'debit', amountMinor: 100_000n },
      { accountCode: payable, direction: 'credit', amountMinor: 100_000n },
      { accountCode: payable, direction: 'debit', amountMinor: 2_500n },
      { accountCode: fees, direction: 'credit', amountMinor: 2_500n },
      { accountCode: '5000:provider_fee_expense', direction: 'debit', amountMinor: 1_000n },
      { accountCode: clearing, direction: 'credit', amountMinor: 1_000n },
    ];
    const posting = validatePosting(draft({ lines, description: '  padded  ' }));
    expect(posting.totalMinor).toBe(103_500n);
    expect(posting.kind).toBe('payment');
    expect(posting.description).toBe('padded');
    expect(posting.createdBy).toBe('system:gateway-consumer');
    expect(posting.transactionId).toBeNull();
    expect(posting.reversesEntryId).toBeNull();
    expect(posting.lines).toEqual(lines);
  });

  it('keeps an explicit kind, transaction id and a missing merchant', () => {
    const posting = validatePosting(
      draft({
        kind: 'collection.succeeded',
        transactionId: '018f3c1e-7d2a-7b4c-9e1f-0123456789ac',
        merchantId: undefined,
        lines: [
          { accountCode: clearing, direction: 'debit', amountMinor: 1n },
          { accountCode: fees, direction: 'credit', amountMinor: 1n },
        ],
      })
    );
    expect(posting.kind).toBe('collection.succeeded');
    expect(posting.transactionId).toBe('018f3c1e-7d2a-7b4c-9e1f-0123456789ac');
    expect(posting.merchantId).toBeNull();
  });

  it('refuses unequal debits and credits with both totals in the details', () => {
    let error: unknown;
    try {
      validatePosting(
        draft({
          lines: [
            { accountCode: clearing, direction: 'debit', amountMinor: 10_000n },
            { accountCode: payable, direction: 'credit', amountMinor: 9_999n },
          ],
        })
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('LEDGER_ENTRY_UNBALANCED');
    expect((error as AppError).details).toEqual({ debitsMinor: '10000', creditsMinor: '9999' });
  });

  it('refuses all-debit or all-credit entries as unbalanced', () => {
    const debitOnly = draft({
      lines: [
        { accountCode: clearing, direction: 'debit', amountMinor: 5n },
        { accountCode: payable, direction: 'debit', amountMinor: 5n },
      ],
    });
    expect(reasonOf(() => validatePosting(debitOnly))).toBe('LEDGER_ENTRY_UNBALANCED');
  });

  const amount = (amountMinor: unknown) =>
    draft({
      lines: [
        { accountCode: clearing, direction: 'debit', amountMinor: amountMinor as bigint },
        { accountCode: payable, direction: 'credit', amountMinor: amountMinor as bigint },
      ],
    });

  it.each([
    ['zero amount', amount(0n), 'amount'],
    ['negative amount', amount(-100n), 'amount'],
    ['float amount', amount(10.5), 'amount'],
    ['number amount', amount(100), 'amount'],
    ['string amount', amount('100'), 'amount'],
    ['amount above bigint', amount(MAX_MINOR + 1n), 'amount'],
    ['bad idempotency key', draft({ idempotencyKey: 'evt_1' }), 'idempotency_key'],
    ['bad environment', draft({ environment: 'prod' as never }), 'environment'],
    ['unsupported currency', draft({ currency: 'CHF' }), 'currency'],
    ['lower-case currency', draft({ currency: 'ugx' }), 'currency'],
    ['unknown source', draft({ source: 'gift' as never }), 'source'],
    ['reversal without target', draft({ source: 'reversal' }), 'source'],
    [
      'target without reversal source',
      draft({ reversesEntryId: '018f3c1e-7d2a-7b4c-9e1f-0123456789ab' }),
      'source',
    ],
    [
      'bad reversal target',
      draft({ source: 'reversal', reversesEntryId: 'x' }),
      'reverses_entry_id',
    ],
    ['empty source id', draft({ sourceId: '' }), 'source_id'],
    ['long source id', draft({ sourceId: 'x'.repeat(129) }), 'source_id'],
    ['bad kind', draft({ kind: 'Collection Succeeded' }), 'kind'],
    ['blank description', draft({ description: '   ' }), 'description'],
    ['long description', draft({ description: 'x'.repeat(501) }), 'description'],
    ['bad merchant id', draft({ merchantId: 'mch_123' }), 'merchant_id'],
    ['bad transaction id', draft({ transactionId: 'txn_123' }), 'transaction_id'],
    ['bad actor type', draft({ createdBy: { type: 'robot' as never, id: 'x' } }), 'created_by'],
    ['bad actor id', draft({ createdBy: { type: 'user', id: 'has space' } }), 'created_by'],
    [
      'one line',
      draft({ lines: [{ accountCode: clearing, direction: 'debit', amountMinor: 1n }] }),
      'line_count',
    ],
    ['no lines', draft({ lines: [] }), 'line_count'],
    [
      'too many lines',
      draft({
        lines: Array.from({ length: MAX_LINES + 2 }, (_, i) => ({
          accountCode: clearing,
          direction: i % 2 === 0 ? ('debit' as const) : ('credit' as const),
          amountMinor: 1n,
        })),
      }),
      'line_count',
    ],
    [
      'malformed account code',
      draft({
        lines: [
          { accountCode: '4000:fee_revenue:x', direction: 'debit', amountMinor: 1n },
          { accountCode: payable, direction: 'credit', amountMinor: 1n },
        ],
      }),
      'account_code',
    ],
    [
      'bad direction',
      draft({
        lines: [
          { accountCode: clearing, direction: 'up' as never, amountMinor: 1n },
          { accountCode: payable, direction: 'credit', amountMinor: 1n },
        ],
      }),
      'direction',
    ],
  ])('refuses %s', (_name, input, reason) => {
    expect(reasonOf(() => validatePosting(input))).toBe(reason);
  });

  it('refuses an entry whose total cannot be stored in a bigint balance', () => {
    const half = MAX_MINOR / 2n + 1n;
    const input = draft({
      lines: [
        { accountCode: clearing, direction: 'debit', amountMinor: half },
        { accountCode: clearing, direction: 'debit', amountMinor: half },
        { accountCode: payable, direction: 'credit', amountMinor: half },
        { accountCode: payable, direction: 'credit', amountMinor: half },
      ],
    });
    expect(reasonOf(() => validatePosting(input))).toBe('amount');
  });

  it('accepts the maximum number of lines', () => {
    const lines = Array.from({ length: MAX_LINES }, (_, i) => ({
      accountCode: i % 2 === 0 ? clearing : payable,
      direction: i % 2 === 0 ? ('debit' as const) : ('credit' as const),
      amountMinor: 7n,
    }));
    expect(validatePosting(draft({ lines })).totalMinor).toBe(350n);
  });

  it('accepts a reversal draft with its target', () => {
    const posting = validatePosting(
      draft({ source: 'reversal', reversesEntryId: '018f3c1e-7d2a-7b4c-9e1f-0123456789ab' })
    );
    expect(posting.reversesEntryId).toBe('018f3c1e-7d2a-7b4c-9e1f-0123456789ab');
  });
});

describe('reverseLines', () => {
  it('flips every direction and keeps accounts, amounts and order', () => {
    const lines = draft().lines;
    expect(reverseLines(lines)).toEqual([
      { accountCode: clearing, direction: 'credit', amountMinor: 10_000n },
      { accountCode: payable, direction: 'debit', amountMinor: 10_000n },
    ]);
    expect(reverseLines(reverseLines(lines))).toEqual(lines);
  });
});

describe('idempotency key and fingerprint', () => {
  it('derives the key as sha256(source:sourceId) (spec 5.5)', () => {
    expect(ledgerIdempotencyKey('payment', 'abc')).toBe(
      'b7d3fc9e633225cef4ff10821978fef78f83449110e4008f4cc0e9c2d7107e72'
    );
    expect(ledgerIdempotencyKey('payment', 'abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(ledgerIdempotencyKey('payment', 'abc')).not.toBe(ledgerIdempotencyKey('refund', 'abc'));
  });

  it('ignores description and actor but changes with anything that moves money', () => {
    const base = postingFingerprint(validatePosting(draft()));
    expect(
      postingFingerprint(
        validatePosting(draft({ description: 'other', createdBy: { type: 'job', id: 'retry' } }))
      )
    ).toBe(base);
    const variants: Partial<PostingDraft>[] = [
      { environment: 'test' },
      { currency: 'RWF' },
      { kind: 'other' },
      { merchantId: undefined },
      { transactionId: '018f3c1e-7d2a-7b4c-9e1f-0123456789ad' },
      { sourceId: 'evt_2' },
      {
        lines: [
          { accountCode: clearing, direction: 'debit', amountMinor: 10_001n },
          { accountCode: payable, direction: 'credit', amountMinor: 10_001n },
        ],
      },
      { lines: reverseLines(draft().lines) },
    ];
    for (const variant of variants) {
      expect(postingFingerprint(validatePosting(draft(variant)))).not.toBe(base);
    }
  });
});

/**
 * Property test (spec 12): random line sets are accepted exactly when they balance, and a
 * reversal of an accepted posting is accepted and nets every account to zero.
 */
describe('posting rules under random input', () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const accounts = [clearing, payable, fees, '1010:provider_float:airtel', '9000:suspense'];

  it('accepts iff debits equal credits, over 5000 random postings', () => {
    let accepted = 0;
    for (let i = 0; i < 5000; i++) {
      const count = 2 + Math.floor(random() * 6);
      const lines: PostingLineInput[] = [];
      for (let j = 0; j < count; j++) {
        lines.push({
          accountCode: accounts[Math.floor(random() * accounts.length)] as string,
          direction: random() < 0.5 ? 'debit' : 'credit',
          amountMinor: BigInt(1 + Math.floor(random() * 1_000_000)),
        });
      }
      // Half the time, add a line that balances the entry.
      const debits = lines
        .filter((l) => l.direction === 'debit')
        .reduce((s, l) => s + l.amountMinor, 0n);
      const credits = lines
        .filter((l) => l.direction === 'credit')
        .reduce((s, l) => s + l.amountMinor, 0n);
      if (random() < 0.5 && debits !== credits) {
        lines.push({
          accountCode: fees,
          direction: debits > credits ? 'credit' : 'debit',
          amountMinor: debits > credits ? debits - credits : credits - debits,
        });
      }
      const d = lines
        .filter((l) => l.direction === 'debit')
        .reduce((s, l) => s + l.amountMinor, 0n);
      const c = lines
        .filter((l) => l.direction === 'credit')
        .reduce((s, l) => s + l.amountMinor, 0n);
      const outcome = reasonOf(() => validatePosting(draft({ lines })));
      if (d === c) {
        expect(outcome).toBeUndefined();
        accepted++;
        const net = new Map<string, bigint>();
        for (const l of [...lines, ...reverseLines(lines)]) {
          const signed = l.direction === 'debit' ? l.amountMinor : -l.amountMinor;
          net.set(l.accountCode, (net.get(l.accountCode) ?? 0n) + signed);
        }
        expect([...net.values()].every((v) => v === 0n)).toBe(true);
        expect(
          reasonOf(() => validatePosting(draft({ lines: reverseLines(lines) })))
        ).toBeUndefined();
      } else {
        expect(outcome).toBe('LEDGER_ENTRY_UNBALANCED');
      }
    }
    expect(accepted).toBeGreaterThan(1000);
  });
});
