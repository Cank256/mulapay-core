/**
 * Object storage behind an explicit interface (spec 2, 4.4). Documents and generated files
 * live in S3-compatible storage; the database holds the object key, the content type, the
 * size and the SHA-256, never the bytes.
 *
 * Uploads and downloads go straight between the client and the store through presigned
 * URLs, so core does not carry document contents. Core itself reads at most the first bytes
 * of an uploaded object (to check its magic bytes) and writes files it generated itself.
 */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** `documents` holds KYC files, `reports` holds generated files such as STR packages. */
export type StorageBucket = 'documents' | 'reports';

export interface PresignedPut {
  readonly url: string;
  readonly method: 'PUT';
  /** The client must send exactly these headers; they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PresignedGet {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly sizeBytes: number;
  readonly contentType: string | null;
  /** The SHA-256 the store verified on upload (hex), or null when it did not keep one. */
  readonly sha256Hex: string | null;
}

export interface PresignPutInput {
  readonly bucket: StorageBucket;
  readonly key: string;
  readonly contentType: string;
  readonly contentLength: number;
  /** Hex SHA-256 of the body. The store rejects an upload whose bytes do not match. */
  readonly sha256Hex: string;
  readonly ttlSeconds: number;
}

export interface PresignGetInput {
  readonly bucket: StorageBucket;
  readonly key: string;
  readonly ttlSeconds: number;
  readonly downloadFilename?: string;
}

export interface ObjectStorage {
  /** False when no store is configured; every other method then refuses to run. */
  readonly configured: boolean;
  presignPut(input: PresignPutInput): PresignedPut;
  presignGet(input: PresignGetInput): PresignedGet;
  /** Null when the object does not exist. */
  head(bucket: StorageBucket, key: string): Promise<StoredObject | null>;
  /** The bytes `start..end` (inclusive) of an object; null when it does not exist. */
  readRange(bucket: StorageBucket, key: string, start: number, end: number): Promise<Buffer | null>;
  /** Stores a file core generated. Safe to repeat: the same key and bytes give the same object. */
  put(bucket: StorageBucket, key: string, body: Buffer, contentType: string): Promise<void>;
  remove(bucket: StorageBucket, key: string): Promise<void>;
}

/** The store did not answer, or answered with something unexpected. Retrying may help. */
export class StorageUnavailableError extends Error {
  constructor(operation: string, detail: string) {
    super(`object storage ${operation} failed: ${detail}`);
    this.name = 'StorageUnavailableError';
  }
}
