/**
 * Identifiers (spec section 2 and 5).
 *
 * - Internal primary keys are UUID v7, generated in the application.
 * - Public identifiers are a type prefix plus a ULID (`mch_01JBX7...`). The ULID's 80
 *   random bits make them unguessable even though the time prefix sorts them (spec
 *   section 11, enumeration). Raw UUIDs never leave the service.
 */
import { randomBytes } from 'node:crypto';

/** Public id prefixes. Each table with a `ref` column has exactly one. */
export const ID_PREFIXES = {
  merchant: 'mch',
  user: 'usr',
  invitation: 'inv',
  session: 'ses',
  apiKey: 'ak',
  account: 'acct',
  journalEntry: 'je',
  transaction: 'txn',
  payment: 'pay',
  paymentLink: 'pl',
  checkoutSession: 'cs',
  hold: 'hold',
  merchantEvent: 'evt',
  webhookEndpoint: 'wh',
  webhookDelivery: 'whd',
  requestLog: 'rl',
  settlementCycle: 'scy',
  settlementRun: 'srun',
  settlementBatch: 'stl',
  settlementDestination: 'sd',
  payout: 'pyt',
  refund: 'rfd',
  reconRun: 'rcr',
  reconException: 'rce',
  reconResolution: 'rca',
  providerStatement: 'pst',
  incident: 'inc',
  kycDocument: 'kdoc',
  kycParty: 'kpty',
  screening: 'scr',
  amlAlert: 'alrt',
  amlCase: 'case',
  strPackage: 'str',
  blocklistEntry: 'bl',
  amlBlock: 'blk',
  dispute: 'dsp',
  complaint: 'cmp',
  notification: 'ntf',
  notificationDelivery: 'ntd',
  report: 'rpt',
  reportSchedule: 'rsc',
  approval: 'apr',
  routingRule: 'rrl',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** RFC 9562 UUID version 7: 48-bit Unix milliseconds, then random bits. */
export function uuidv7(now: Date = new Date()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now.getTime());
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-character ULID: 10 characters of time, 16 of randomness (Crockford base32). */
export function ulid(now: Date = new Date()): string {
  let time = now.getTime();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(10);
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    randomPart = CROCKFORD.charAt(Number(bits & 31n)) + randomPart;
    bits >>= 5n;
  }
  return timePart + randomPart;
}

export function publicId(kind: IdKind, now: Date = new Date()): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

const PUBLIC_ID = /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when `value` is a well-formed public id of the given kind. */
export function isPublicId(kind: IdKind, value: string): boolean {
  return PUBLIC_ID.test(value) && value.startsWith(`${ID_PREFIXES[kind]}_`);
}

/**
 * The creation time embedded in a ULID or a public id that ends in one. Partitioned tables
 * whose rows are created at the id's own time (webhook deliveries, request logs) use it to
 * turn a lookup by ref into a read of one partition. Null if `value` is not well formed.
 */
export function ulidTimestamp(value: string): number | null {
  const body = value.slice(-26);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(body)) return null;
  let ms = 0;
  for (const char of body.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(char);
  return ms;
}
