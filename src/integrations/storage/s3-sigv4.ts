/**
 * AWS Signature Version 4 for S3, the two forms core needs and nothing else:
 *
 *  - `presignUrl`: query-string authentication, for the presigned PUT a merchant uploads a
 *    document with and the presigned GET staff view one with. The signature covers the
 *    method, path, the signed headers and an expiry, so a URL cannot be reused for another
 *    object, another method or after it lapses.
 *  - `signHeaders`: the `Authorization` header for the few requests core makes itself (HEAD,
 *    ranged GET, PUT of a generated file, DELETE).
 *
 * Pure: no clock, no I/O. The caller passes the signing time, so tests are exact and
 * `s3-sigv4.spec.ts` checks the output against the worked examples in the AWS documentation.
 * A hand-written signer rather than the AWS SDK, because core needs only these two forms and
 * the SDK would add a large dependency tree to a service that holds money.
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 encoding as AWS defines it: only unreserved characters stay as they are. */
export function awsEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

/** `20130524T000000Z` and `20130524`. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(credentials: S3Credentials, dateStamp: string): Buffer {
  const date = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const region = hmac(date, credentials.region);
  const service = hmac(region, 's3');
  return hmac(service, 'aws4_request');
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  block: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    block: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

function signature(
  credentials: S3Credentials,
  amzDate: string,
  dateStamp: string,
  canonicalRequest: string
): { scope: string; value: string } {
  const scope = `${dateStamp}/${credentials.region}/s3/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  return {
    scope,
    value: createHmac('sha256', signingKey(credentials, dateStamp))
      .update(stringToSign, 'utf8')
      .digest('hex'),
  };
}

export interface PresignInput {
  readonly method: 'GET' | 'PUT';
  readonly host: string;
  /** The request path, not yet encoded: `/bucket/kyc/a b.pdf` or `/kyc/a b.pdf`. */
  readonly path: string;
  readonly credentials: S3Credentials;
  readonly now: Date;
  readonly expiresSeconds: number;
  /**
   * Headers the client must send exactly as given (content type, length, checksum,
   * encryption). `host` is added here. They are part of the signature.
   */
  readonly signedHeaders?: Readonly<Record<string, string>>;
  /** Extra query parameters, for example `response-content-disposition`. */
  readonly query?: Readonly<Record<string, string>>;
}

/** Returns the query string (without `?`) that authorises the request, signature included. */
export function presignQuery(input: PresignInput): string {
  const { amzDate, dateStamp } = amzDates(input.now);
  const headers = { ...input.signedHeaders, host: input.host };
  const { block, signed } = canonicalHeaders(headers);
  const scope = `${dateStamp}/${input.credentials.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    ...input.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresSeconds),
    'X-Amz-SignedHeaders': signed,
  };
  const canonicalRequest = [
    input.method,
    awsEncode(input.path, true),
    canonicalQuery(query),
    block,
    signed,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const { value } = signature(input.credentials, amzDate, dateStamp, canonicalRequest);
  return `${canonicalQuery(query)}&X-Amz-Signature=${value}`;
}

export interface SignHeadersInput {
  readonly method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
  readonly host: string;
  readonly path: string;
  readonly credentials: S3Credentials;
  readonly now: Date;
  /** sha256 hex of the body; `EMPTY_PAYLOAD_SHA256` for no body. */
  readonly payloadSha256: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The headers to send, including `Authorization`, `x-amz-date` and `x-amz-content-sha256`. */
export function signHeaders(input: SignHeadersInput): Record<string, string> {
  const { amzDate, dateStamp } = amzDates(input.now);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.host,
    'x-amz-content-sha256': input.payloadSha256,
    'x-amz-date': amzDate,
  };
  const { block, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    input.method,
    awsEncode(input.path, true),
    '',
    block,
    signed,
    input.payloadSha256,
  ].join('\n');
  const { scope, value } = signature(input.credentials, amzDate, dateStamp, canonicalRequest);
  const send = { ...headers };
  delete send.host;
  return {
    ...send,
    authorization: `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${value}`,
  };
}
