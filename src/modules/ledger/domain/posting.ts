/**
 * Posting rules (spec 5.3, 5.5, 6.6). Pure: no I/O, so every rule is unit-tested and the
 * posting service checks a posting completely before touching the database. The
 * database checks the same invariants again (migration 0002).
 */
import type { ActorType } from '../../../common/context/request-context';
import { sha256Hex } from '../../../common/crypto/crypto';
import { AppError } from '../../../common/errors/app-error';
import { isSupportedCurrency, type CurrencyCode } from '../../../common/money/currency-codes';
import { isPositiveMinor, MAX_MINOR } from '../../../common/money/minor-units';
import { isAccountCode, type LedgerEnvironment } from '../../accounts/domain/chart-of-accounts';

export const ENTRY_SOURCES = [
  'payment',
  'payout',
  'refund',
  'fee',
  'settlement',
  'adjustment',
  'reversal',
] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];
/** Sources a caller may post directly. Reversals go through ReversalService only. */
export type PostableSource = Exclude<EntrySource, 'reversal'>;
export type Direction = 'debit' | 'credit';

export const MIN_LINES = 2;
export const MAX_LINES = 100;

export interface PostingLineInput {
  readonly accountCode: string;
  readonly direction: Direction;
  readonly amountMinor: bigint;
}

/** Who made the posting: a user, an API key, the system or a job (stored as `type:id`). */
export interface LedgerActor {
  readonly type: ActorType;
  readonly id: string;
}

/** The input of `PostingService.postEntry` (spec 6.6), plus the environment (spec 5). */
export interface PostEntryInput {
  /** `ledgerIdempotencyKey(source, sourceId)` unless one source posts several entries. */
  readonly idempotencyKey: string;
  readonly environment: LedgerEnvironment;
  readonly currency: string;
  readonly source: PostableSource;
  /** The originating business operation: gateway event id, payout id, settlement id... */
  readonly sourceId: string;
  /** Posting template, for example `collection.succeeded`. Defaults to the source. */
  readonly kind?: string;
  readonly merchantId?: string;
  readonly transactionId?: string;
  readonly description: string;
  readonly lines: readonly PostingLineInput[];
  readonly createdBy: LedgerActor;
  /**
   * Lets this posting take a merchant liability account into a debit (negative) position.
   * Off by default (spec 5.3 rule 7); only an explicit, approved policy may set it.
   */
  readonly allowNegativeMerchantBalance?: boolean;
}

/** A posting that passed every rule, with defaults applied. */
export interface ValidatedPosting {
  readonly idempotencyKey: string;
  readonly environment: LedgerEnvironment;
  readonly currency: CurrencyCode;
  readonly source: EntrySource;
  readonly sourceId: string;
  readonly kind: string;
  readonly merchantId: string | null;
  readonly transactionId: string | null;
  readonly reversesEntryId: string | null;
  readonly description: string;
  readonly lines: readonly PostingLineInput[];
  readonly createdBy: string;
  readonly totalMinor: bigint;
}

/** Input accepted by `validatePosting`: the public input, or a reversal built internally. */
export type PostingDraft = Omit<PostEntryInput, 'source' | 'allowNegativeMerchantBalance'> & {
  readonly source: EntrySource;
  readonly reversesEntryId?: string;
};

const HEX_64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^[a-z][a-z0-9_.]{0,63}$/;
const ACTOR_TYPES: readonly string[] = ['user', 'api_key', 'system', 'job'];
const ACTOR_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function invalid(reason: string): AppError {
  return new AppError('LEDGER_POSTING_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

function optionalUuid(value: string | undefined, reason: string): string | null {
  if (value === undefined) return null;
  if (!UUID.test(value)) throw invalid(reason);
  return value;
}

/**
 * Checks a posting against every ledger rule and returns it normalised. Throws
 * LEDGER_POSTING_INVALID (with a machine-readable `reason`) or LEDGER_ENTRY_UNBALANCED.
 */
export function validatePosting(draft: PostingDraft): ValidatedPosting {
  if (!HEX_64.test(draft.idempotencyKey)) throw invalid('idempotency_key');
  if (draft.environment !== 'test' && draft.environment !== 'live') throw invalid('environment');
  if (!isSupportedCurrency(draft.currency)) throw invalid('currency');
  if (!(ENTRY_SOURCES as readonly string[]).includes(draft.source)) throw invalid('source');
  if (draft.sourceId.length < 1 || draft.sourceId.length > 128) throw invalid('source_id');
  const kind = draft.kind ?? draft.source;
  if (!KIND.test(kind)) throw invalid('kind');
  const description = draft.description.trim();
  if (description.length < 1 || description.length > 500) throw invalid('description');
  const merchantId = optionalUuid(draft.merchantId, 'merchant_id');
  const transactionId = optionalUuid(draft.transactionId, 'transaction_id');
  const reversesEntryId = optionalUuid(draft.reversesEntryId, 'reverses_entry_id');
  if ((draft.source === 'reversal') !== (reversesEntryId !== null)) throw invalid('source');
  if (!ACTOR_TYPES.includes(draft.createdBy.type) || !ACTOR_ID.test(draft.createdBy.id)) {
    throw invalid('created_by');
  }
  if (draft.lines.length < MIN_LINES || draft.lines.length > MAX_LINES) {
    throw invalid('line_count');
  }

  let debits = 0n;
  let credits = 0n;
  for (const line of draft.lines) {
    if (!isAccountCode(line.accountCode)) throw invalid('account_code');
    if (line.direction !== 'debit' && line.direction !== 'credit') throw invalid('direction');
    if (!isPositiveMinor(line.amountMinor)) throw invalid('amount');
    if (line.direction === 'debit') debits += line.amountMinor;
    else credits += line.amountMinor;
  }
  if (debits !== credits) {
    throw new AppError('LEDGER_ENTRY_UNBALANCED', {
      details: { debitsMinor: debits.toString(), creditsMinor: credits.toString() },
    });
  }
  // Each balance total is a Postgres bigint; refuse an entry that could not be stored.
  if (debits > MAX_MINOR) throw invalid('amount');

  return {
    idempotencyKey: draft.idempotencyKey,
    environment: draft.environment,
    currency: draft.currency,
    source: draft.source,
    sourceId: draft.sourceId,
    kind,
    merchantId,
    transactionId,
    reversesEntryId,
    description,
    lines: draft.lines.map((l) => ({
      accountCode: l.accountCode,
      direction: l.direction,
      amountMinor: l.amountMinor,
    })),
    createdBy: `${draft.createdBy.type}:${draft.createdBy.id}`,
    totalMinor: debits,
  };
}

/** The lines of a reversal: every line of the original with its direction flipped. */
export function reverseLines(lines: readonly PostingLineInput[]): PostingLineInput[] {
  return lines.map((line) => ({
    accountCode: line.accountCode,
    direction: line.direction === 'debit' ? 'credit' : 'debit',
    amountMinor: line.amountMinor,
  }));
}

/** `sha256(source + ':' + sourceId)` (spec 5.5). Replaying the same event is a no-op. */
export function ledgerIdempotencyKey(source: EntrySource, sourceId: string): string {
  return sha256Hex(`${source}:${sourceId}`);
}

/**
 * Fingerprint of everything that decides the financial effect of a posting. A replay with
 * the same key and fingerprint returns the original entry; a different fingerprint is a
 * conflict. Description and actor are not part of it: they do not move money, and a
 * retried operation may legitimately be described or attributed differently.
 */
export function postingFingerprint(posting: ValidatedPosting): string {
  return sha256Hex(
    JSON.stringify([
      posting.environment,
      posting.currency,
      posting.source,
      posting.sourceId,
      posting.kind,
      posting.merchantId,
      posting.transactionId,
      posting.reversesEntryId,
      posting.lines.map((l) => [l.accountCode, l.direction, l.amountMinor.toString()]),
    ])
  );
}
