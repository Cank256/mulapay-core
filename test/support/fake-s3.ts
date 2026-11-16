/**
 * An in-process S3-compatible server for the KYC and STR tests. It behaves like the parts of
 * S3 that core relies on:
 *
 *  - path-style `PUT/HEAD/GET/DELETE /{bucket}/{key}`;
 *  - a PUT must carry the `x-amz-checksum-sha256` it was presigned with, and the body must
 *    hash to it, and `content-length` must match, as S3 enforces for a signed upload;
 *  - a presigned URL must be unexpired (`X-Amz-Date` + `X-Amz-Expires`) and name the signed
 *    headers; HEAD returns the stored checksum when asked (`x-amz-checksum-mode: ENABLED`);
 *  - ranged GET (`Range: bytes=a-b`) answers 206 with just those bytes.
 *
 * It does not verify the signature itself: `s3-sigv4.spec.ts` proves the signer against the
 * AWS worked examples. It records every request, so a test can assert that core fetched only
 * the first bytes of an object and never the whole file.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StoredFile {
  readonly body: Buffer;
  readonly contentType: string;
  readonly checksumBase64: string;
  readonly encryption: string | null;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly range: string | null;
  readonly presigned: boolean;
}

export const FAKE_S3 = {
  accessKeyId: 'AKIAFAKEFAKEFAKEFAKE',
  secretAccessKey: 'fakeSecretAccessKey1234567890abcdefghijkl',
  region: 'us-east-1',
  documents: 'mulapay-documents',
  reports: 'mulapay-reports',
} as const;

/** S3 refuses a part smaller than this unless it is the last one of the upload. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

export interface FakeS3 {
  readonly endpoint: string;
  readonly objects: Map<string, StoredFile>;
  readonly requests: RecordedRequest[];
  /** Multipart uploads in progress (started, not completed or aborted). */
  readonly uploads: Map<
    string,
    { key: string; contentType: string; encryption: string | null; parts: Map<number, Buffer> }
  >;
  /** The largest request body received, to prove a streamed file was never sent whole. */
  maxBodyBytes: number;
  /** When set, every request answers this status (an outage). */
  failWith: number | null;
  config(overrides?: Record<string, string>): Record<string, string>;
  /** Puts a file in directly, as if uploaded through a presigned URL. */
  seed(bucket: string, key: string, body: Buffer, contentType: string): void;
  close(): Promise<void>;
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function expired(params: URLSearchParams): boolean {
  const date = params.get('X-Amz-Date');
  const seconds = Number(params.get('X-Amz-Expires'));
  if (!date || !Number.isFinite(seconds)) return false;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`;
  return Date.now() > new Date(iso).getTime() + seconds * 1000 + 24 * 3600_000;
}

export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, StoredFile>();
  const requests: RecordedRequest[] = [];
  const uploads = new Map<
    string,
    { key: string; contentType: string; encryption: string | null; parts: Map<number, Buffer> }
  >();
  const state = { failWith: null as number | null, maxBodyBytes: 0 };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      const presigned = url.searchParams.has('X-Amz-Signature');
      requests.push({
        method: req.method ?? '',
        path,
        range: req.headers.range ?? null,
        presigned,
      });
      const body = await read(req);
      state.maxBodyBytes = Math.max(state.maxBodyBytes, body.length);
      if (state.failWith) {
        res.writeHead(state.failWith).end();
        return;
      }
      if (presigned && expired(url.searchParams)) {
        res.writeHead(403).end('expired');
        return;
      }
      const key = path.replace(/^\//, '');
      const uploadId = url.searchParams.get('uploadId');
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        const id = `upload-${uploads.size + 1}-${Date.now()}`;
        uploads.set(id, {
          key,
          contentType: req.headers['content-type'] ?? 'binary/octet-stream',
          // As in S3, the encryption is chosen when the upload starts.
          encryption: (req.headers['x-amz-server-side-encryption'] as string | undefined) ?? null,
          parts: new Map(),
        });
        res
          .writeHead(200, { 'content-type': 'application/xml' })
          .end(
            `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`
          );
        return;
      }
      if (uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) {
          res.writeHead(404).end('NoSuchUpload');
          return;
        }
        if (req.method === 'PUT') {
          const number = Number(url.searchParams.get('partNumber'));
          upload.parts.set(number, body);
          res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` }).end();
          return;
        }
        if (req.method === 'DELETE') {
          uploads.delete(uploadId);
          res.writeHead(204).end();
          return;
        }
        if (req.method === 'POST') {
          const numbers = [
            ...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
          ].map((m) => Number(m[1]));
          const ordered = numbers.map((n) => upload.parts.get(n));
          if (ordered.some((p) => p === undefined)) {
            res.writeHead(400).end('<Error><Code>InvalidPart</Code></Error>');
            return;
          }
          const small = ordered.slice(0, -1).some((p) => (p as Buffer).length < MIN_PART_BYTES);
          if (small) {
            res.writeHead(400).end('<Error><Code>EntityTooSmall</Code></Error>');
            return;
          }
          const whole = Buffer.concat(ordered as Buffer[]);
          objects.set(key, {
            body: whole,
            contentType: upload.contentType,
            checksumBase64: createHash('sha256').update(whole).digest('base64'),
            encryption: upload.encryption,
          });
          uploads.delete(uploadId);
          res
            .writeHead(200, { 'content-type': 'application/xml' })
            .end('<CompleteMultipartUploadResult/>');
          return;
        }
      }
      if (req.method === 'PUT') {
        const declared = req.headers['x-amz-checksum-sha256'] as string | undefined;
        const actual = createHash('sha256').update(body).digest('base64');
        if (presigned) {
          const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
          for (const h of ['content-type', 'content-length', 'x-amz-checksum-sha256']) {
            if (!signed.split(';').includes(h)) {
              res.writeHead(403).end(`header ${h} is not signed`);
              return;
            }
          }
        }
        if (declared && declared !== actual) {
          res.writeHead(400).end('BadDigest');
          return;
        }
        if (
          req.headers['content-length'] &&
          Number(req.headers['content-length']) !== body.length
        ) {
          res.writeHead(400).end('IncompleteBody');
          return;
        }
        objects.set(key, {
          body,
          contentType: req.headers['content-type'] ?? 'binary/octet-stream',
          checksumBase64: actual,
          encryption: (req.headers['x-amz-server-side-encryption'] as string | undefined) ?? null,
        });
        res.writeHead(200).end();
        return;
      }
      const file = objects.get(key);
      if (!file) {
        res.writeHead(404).end('NoSuchKey');
        return;
      }
      if (req.method === 'HEAD') {
        const headers: Record<string, string | number> = {
          'content-length': file.body.length,
          'content-type': file.contentType,
        };
        if (req.headers['x-amz-checksum-mode'] === 'ENABLED') {
          headers['x-amz-checksum-sha256'] = file.checksumBase64;
        }
        res.writeHead(200, headers).end();
        return;
      }
      if (req.method === 'GET') {
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        if (range) {
          const part = file.body.subarray(Number(range[1]), Number(range[2]) + 1);
          res.writeHead(206, { 'content-type': file.contentType, 'content-length': part.length });
          res.end(part);
          return;
        }
        res.writeHead(200, {
          'content-type': file.contentType,
          'content-length': file.body.length,
        });
        res.end(file.body);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint,
    objects,
    requests,
    uploads,
    get maxBodyBytes() {
      return state.maxBodyBytes;
    },
    set maxBodyBytes(value: number) {
      state.maxBodyBytes = value;
    },
    get failWith() {
      return state.failWith;
    },
    set failWith(value: number | null) {
      state.failWith = value;
    },
    config: (overrides = {}) => ({
      S3_ENDPOINT: endpoint,
      S3_REGION: FAKE_S3.region,
      S3_BUCKET_DOCUMENTS: FAKE_S3.documents,
      S3_BUCKET_REPORTS: FAKE_S3.reports,
      S3_ACCESS_KEY_ID: FAKE_S3.accessKeyId,
      S3_SECRET_ACCESS_KEY: FAKE_S3.secretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
      S3_SERVER_SIDE_ENCRYPTION: 'AES256',
      ...overrides,
    }),
    seed(bucket, key, body, contentType) {
      objects.set(`${bucket}/${key}`, {
        body,
        contentType,
        checksumBase64: createHash('sha256').update(body).digest('base64'),
        encryption: null,
      });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
