import { describe, expect, it } from 'vitest';
import { checkSignature, detectDocumentType, isAllowedDocumentType } from './file-signature';

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe('document signatures', () => {
  it('recognises PDF, JPEG and PNG by their first bytes', () => {
    expect(detectDocumentType(PDF)).toBe('application/pdf');
    expect(detectDocumentType(JPEG)).toBe('image/jpeg');
    expect(detectDocumentType(PNG)).toBe('image/png');
  });

  it('refuses everything else, whatever it is called', () => {
    expect(detectDocumentType(Buffer.from('MZ\x90\x00', 'latin1'))).toBeNull(); // a Windows executable
    expect(detectDocumentType(Buffer.from('<html><script>', 'utf8'))).toBeNull();
    expect(detectDocumentType(Buffer.from('GIF89a', 'latin1'))).toBeNull();
    expect(detectDocumentType(Buffer.from('PK\x03\x04', 'latin1'))).toBeNull(); // a zip or docx
    expect(detectDocumentType(Buffer.alloc(0))).toBeNull();
  });

  it('does not accept a truncated signature', () => {
    expect(detectDocumentType(PNG.subarray(0, 7))).toBeNull();
    expect(detectDocumentType(JPEG.subarray(0, 2))).toBeNull();
    expect(detectDocumentType(PDF.subarray(0, 4))).toBeNull();
  });

  it('checks the bytes against the declared type', () => {
    expect(checkSignature(PDF, 'application/pdf')).toEqual({ ok: true, mime: 'application/pdf' });
    expect(checkSignature(PNG, 'application/pdf')).toEqual({
      ok: false,
      reason: 'content_type_mismatch',
    });
    expect(checkSignature(Buffer.from('hello'), 'image/png')).toEqual({
      ok: false,
      reason: 'unsupported_file_type',
    });
  });

  it('allows exactly three declared types', () => {
    expect(['application/pdf', 'image/jpeg', 'image/png'].every(isAllowedDocumentType)).toBe(true);
    expect(isAllowedDocumentType('image/gif')).toBe(false);
    expect(isAllowedDocumentType('application/zip')).toBe(false);
  });
});
