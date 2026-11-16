/**
 * S3-compatible implementation of `ObjectStorage` (AWS S3, MinIO, R2 and similar).
 *
 * Presigning is local: no request is made. `head`, `readRange`, `put` and `remove` call the
 * store with a hard timeout (`REQUEST_TIMEOUT_MS`) and sign with the same credentials. A
 * timeout or a 5xx is a `StorageUnavailableError`; the caller decides whether to retry,
 * because every operation here is safe to repeat (reads, an overwrite of the same bytes, a
 * delete).
 *
 * Every presigned upload carries the content type, the exact length, the SHA-256 of the body
 * and, when configured, the server-side-encryption header in its signature. The store
 * therefore refuses an upload that is bigger, smaller or different from what was declared,
 * and encrypts what it keeps (spec 11).
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { request } from 'undici';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../common/tokens';
import {
  StorageUnavailableError,
  type ObjectStorage,
  type PresignGetInput,
  type PresignPutInput,
  type PresignedGet,
  type PresignedPut,
  type StorageBucket,
  type StoredObject,
} from './object-storage.port';
import { EMPTY_PAYLOAD_SHA256, presignQuery, signHeaders, type S3Credentials } from './s3-sigv4';
import { AppError } from '../../common/errors/app-error';
import { CLOCK } from '../../common/tokens';
import type { Clock } from '../../common/clock/clock';

const REQUEST_TIMEOUT_MS = 10_000;

type StorageConfig = Pick<
  AppConfig,
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET_DOCUMENTS'
  | 'S3_BUCKET_REPORTS'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_FORCE_PATH_STYLE'
  | 'S3_SERVER_SIDE_ENCRYPTION'
>;

interface Target {
  readonly host: string;
  readonly path: string;
  readonly origin: string;
}

@Injectable()
export class S3ObjectStorage implements ObjectStorage {
  private readonly credentials: S3Credentials | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: StorageConfig,
    @Inject(CLOCK) private readonly clock: Clock
  ) {
    if (config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY && config.S3_REGION) {
      this.credentials = {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        region: config.S3_REGION,
      };
    }
  }

  get configured(): boolean {
    return this.credentials !== undefined && this.bucketName('documents') !== undefined;
  }

  presignPut(input: PresignPutInput): PresignedPut {
    const { credentials, target } = this.resolve(input.bucket, input.key);
    const now = this.clock.now();
    const headers: Record<string, string> = {
      'content-type': input.contentType,
      'content-length': String(input.contentLength),
      'x-amz-checksum-sha256': Buffer.from(input.sha256Hex, 'hex').toString('base64'),
    };
    if (this.config.S3_SERVER_SIDE_ENCRYPTION) {
      headers['x-amz-server-side-encryption'] = this.config.S3_SERVER_SIDE_ENCRYPTION;
    }
    const query = presignQuery({
      method: 'PUT',
      host: target.host,
      path: target.path,
      credentials,
      now,
      expiresSeconds: input.ttlSeconds,
      signedHeaders: headers,
    });
    return {
      url: `${target.origin}${encodePath(target.path)}?${query}`,
      method: 'PUT',
      headers,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
    };
  }

  presignGet(input: PresignGetInput): PresignedGet {
    const { credentials, target } = this.resolve(input.bucket, input.key);
    const now = this.clock.now();
    const query = presignQuery({
      method: 'GET',
      host: target.host,
      path: target.path,
      credentials,
      now,
      expiresSeconds: input.ttlSeconds,
      query: input.downloadFilename
        ? {
            'response-content-disposition': `attachment; filename="${input.downloadFilename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
          }
        : undefined,
    });
    return {
      url: `${target.origin}${encodePath(target.path)}?${query}`,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
    };
  }

  async head(bucket: StorageBucket, key: string): Promise<StoredObject | null> {
    const res = await this.send('HEAD', bucket, key, { 'x-amz-checksum-mode': 'ENABLED' });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new StorageUnavailableError('head', `status ${res.status}`);
    const checksum = header(res.headers['x-amz-checksum-sha256']);
    return {
      sizeBytes: Number(header(res.headers['content-length']) ?? '0'),
      contentType: header(res.headers['content-type']) ?? null,
      sha256Hex: checksum ? Buffer.from(checksum, 'base64').toString('hex') : null,
    };
  }

  async readRange(
    bucket: StorageBucket,
    key: string,
    start: number,
    end: number
  ): Promise<Buffer | null> {
    const res = await this.send('GET', bucket, key, { range: `bytes=${start}-${end}` });
    if (res.status === 404) return null;
    if (res.status !== 200 && res.status !== 206) {
      throw new StorageUnavailableError('read', `status ${res.status}`);
    }
    return res.body;
  }

  async put(bucket: StorageBucket, key: string, body: Buffer, contentType: string): Promise<void> {
    const headers: Record<string, string> = { 'content-type': contentType };
    if (this.config.S3_SERVER_SIDE_ENCRYPTION) {
      headers['x-amz-server-side-encryption'] = this.config.S3_SERVER_SIDE_ENCRYPTION;
    }
    const res = await this.send('PUT', bucket, key, headers, body);
    if (res.status !== 200) throw new StorageUnavailableError('put', `status ${res.status}`);
  }

  async remove(bucket: StorageBucket, key: string): Promise<void> {
    const res = await this.send('DELETE', bucket, key);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new StorageUnavailableError('delete', `status ${res.status}`);
    }
  }

  private bucketName(bucket: StorageBucket): string | undefined {
    return bucket === 'documents' ? this.config.S3_BUCKET_DOCUMENTS : this.config.S3_BUCKET_REPORTS;
  }

  private resolve(
    bucket: StorageBucket,
    key: string
  ): { credentials: S3Credentials; target: Target } {
    const name = this.bucketName(bucket);
    if (!this.credentials || !name) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        cause: new Error(`object storage is not configured for the ${bucket} bucket`),
      });
    }
    const pathKey = `/${key}`;
    const endpoint = this.config.S3_ENDPOINT ? new URL(this.config.S3_ENDPOINT) : undefined;
    if (endpoint && (this.config.S3_FORCE_PATH_STYLE || isIpOrLocal(endpoint.hostname))) {
      return {
        credentials: this.credentials,
        target: { host: endpoint.host, path: `/${name}${pathKey}`, origin: endpoint.origin },
      };
    }
    const base = endpoint?.host ?? `s3.${this.credentials.region}.amazonaws.com`;
    const host = `${name}.${base}`;
    const protocol = endpoint?.protocol ?? 'https:';
    return {
      credentials: this.credentials,
      target: { host, path: pathKey, origin: `${protocol}//${host}` },
    };
  }

  private async send(
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    bucket: StorageBucket,
    key: string,
    extraHeaders: Record<string, string> = {},
    body?: Buffer
  ): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }> {
    const { credentials, target } = this.resolve(bucket, key);
    const headers = signHeaders({
      method,
      host: target.host,
      path: target.path,
      credentials,
      now: this.clock.now(),
      payloadSha256: body ? createHash('sha256').update(body).digest('hex') : EMPTY_PAYLOAD_SHA256,
      headers: extraHeaders,
    });
    try {
      const res = await request(`${target.origin}${encodePath(target.path)}`, {
        method,
        headers,
        ...(body ? { body } : {}),
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      });
      const bytes = Buffer.from(await res.body.arrayBuffer());
      if (res.statusCode >= 500) {
        throw new StorageUnavailableError(method.toLowerCase(), `status ${res.statusCode}`);
      }
      return { status: res.statusCode, headers: res.headers, body: bytes };
    } catch (error) {
      if (error instanceof StorageUnavailableError) throw error;
      throw new StorageUnavailableError(
        method.toLowerCase(),
        error instanceof Error ? error.name : 'unknown error'
      );
    }
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
      )
    )
    .join('/');
}

/** Local and IP endpoints cannot use virtual-hosted addressing. */
function isIpOrLocal(hostname: string): boolean {
  return hostname === 'localhost' || /^[0-9.]+$/.test(hostname) || hostname.includes(':');
}
