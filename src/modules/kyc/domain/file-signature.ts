/**
 * What a file is, decided by its first bytes and never by its name or the type the client
 * claims (spec 6.13, 11). Pure.
 *
 * A browser or a script can label any file `application/pdf`; only the signature at the start
 * of the file says what it is. Core reads the first `SIGNATURE_BYTES` bytes of an uploaded
 * object and refuses anything that is not a PDF, JPEG or PNG, or whose signature disagrees
 * with the type it was declared as.
 */
export const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentMime = (typeof ALLOWED_DOCUMENT_TYPES)[number];

/** The longest signature checked (PNG, 8 bytes), rounded up. */
export const SIGNATURE_BYTES = 16;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const PDF = Buffer.from('%PDF-', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

/** The type the bytes say the file is, or null when it is none of the allowed types. */
export function detectDocumentType(bytes: Buffer): DocumentMime | null {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  return null;
}

export function isAllowedDocumentType(value: string): value is DocumentMime {
  return (ALLOWED_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export type SignatureVerdict =
  | { readonly ok: true; readonly mime: DocumentMime }
  | { readonly ok: false; readonly reason: 'unsupported_file_type' | 'content_type_mismatch' };

/** Checks the bytes against the type the client declared. */
export function checkSignature(bytes: Buffer, declared: DocumentMime): SignatureVerdict {
  const detected = detectDocumentType(bytes);
  if (detected === null) return { ok: false, reason: 'unsupported_file_type' };
  if (detected !== declared) return { ok: false, reason: 'content_type_mismatch' };
  return { ok: true, mime: detected };
}
