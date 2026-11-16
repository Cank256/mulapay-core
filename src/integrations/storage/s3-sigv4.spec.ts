import { describe, expect, it } from 'vitest';
import {
  awsEncode,
  amzDates,
  EMPTY_PAYLOAD_SHA256,
  presignQuery,
  signHeaders,
  type S3Credentials,
} from './s3-sigv4';

/** The example credentials and times from the AWS Signature Version 4 documentation. */
const AWS_EXAMPLE: S3Credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};
const AWS_TIME = new Date('2013-05-24T00:00:00Z');

describe('s3 signature version 4', () => {
  it('reproduces the presigned GET worked example from the AWS documentation', () => {
    const query = presignQuery({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      credentials: AWS_EXAMPLE,
      now: AWS_TIME,
      expiresSeconds: 86400,
    });
    expect(query).toBe(
      'X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  it('reproduces the GET object (header authorization) worked example', () => {
    const headers = signHeaders({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      credentials: AWS_EXAMPLE,
      now: AWS_TIME,
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      headers: { range: 'bytes=0-9' },
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
    expect(headers.host).toBeUndefined();
  });

  it('binds the signature to the signed headers', () => {
    const base = {
      method: 'PUT' as const,
      host: 'b.s3.amazonaws.com',
      path: '/k',
      credentials: AWS_EXAMPLE,
      now: AWS_TIME,
      expiresSeconds: 900,
    };
    const a = presignQuery({ ...base, signedHeaders: { 'content-type': 'application/pdf' } });
    const b = presignQuery({ ...base, signedHeaders: { 'content-type': 'image/png' } });
    expect(a).toContain('X-Amz-SignedHeaders=content-type%3Bhost');
    expect(a).not.toBe(b);
  });

  it('encodes paths and query values the way AWS does', () => {
    expect(awsEncode("a b/(c)*'d'!", true)).toBe('a%20b/%28c%29%2A%27d%27%21');
    expect(awsEncode('a/b')).toBe('a%2Fb');
    expect(amzDates(new Date('2024-02-29T13:05:09.123Z'))).toEqual({
      amzDate: '20240229T130509Z',
      dateStamp: '20240229',
    });
  });
});
