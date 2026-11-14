import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from './app-error';
import { ERROR_CATALOGUE, errorDocUrl, renderMessage } from './catalogue';
import { resolveError } from './error-mapper';

describe('error catalogue', () => {
  it('never exposes details on server errors', () => {
    for (const def of Object.values(ERROR_CATALOGUE)) {
      if (def.httpStatus >= 500) expect(def.exposeDetails).toBe(false);
    }
  });

  it('builds doc URLs and renders message templates', () => {
    expect(errorDocUrl('NOT_FOUND')).toBe('https://docs.mulapay.com/errors/not_found');
    expect(renderMessage('Amount {amount} in {currency}', { amount: '10', currency: 'UGX' })).toBe(
      'Amount 10 in UGX'
    );
    expect(renderMessage('Keep {missing}', {})).toBe('Keep {missing}');
    expect(renderMessage('No params')).toBe('No params');
  });
});

describe('resolveError', () => {
  it('maps AppError through the catalogue, keeping safe details', () => {
    const resolved = resolveError(new AppError('VALIDATION_FAILED', { details: { field: 'x' } }));
    expect(resolved).toEqual({
      code: 'VALIDATION_FAILED',
      httpStatus: 400,
      message: ERROR_CATALOGUE.VALIDATION_FAILED.message,
      details: { field: 'x' },
      isServerError: false,
    });
    expect(new AppError('NOT_FOUND').httpStatus).toBe(404);
  });

  it('drops details the catalogue does not mark safe', () => {
    expect(
      resolveError(new AppError('NOT_FOUND', { details: { id: 'x' } })).details
    ).toBeUndefined();
    expect(
      resolveError(new AppError('INTERNAL_ERROR', { details: { sql: 'select' } })).details
    ).toBeUndefined();
  });

  it('turns Zod validation failures into a per-field list without input values', () => {
    const schema = z.object({
      amount: z.string(),
      nested: z.object({ currency: z.string().length(3) }),
    });
    const parsed = schema.safeParse({ amount: 12, nested: { currency: 'SECRETVALUE' } });
    if (parsed.success) throw new Error('expected failure');
    const resolved = resolveError(new ZodValidationException(parsed.error));
    expect(resolved.code).toBe('VALIDATION_FAILED');
    expect(resolved.httpStatus).toBe(400);
    expect(resolved.details).toEqual({
      fields: [
        { path: 'amount', code: 'invalid_type', message: expect.any(String) },
        { path: 'nested.currency', code: 'too_big', message: expect.any(String) },
      ],
    });
    expect(JSON.stringify(resolved)).not.toContain('SECRETVALUE');
  });

  it.each([
    [new BadRequestException('raw message'), 'INVALID_REQUEST', 400],
    [new UnauthorizedException(), 'UNAUTHORIZED', 401],
    [new ForbiddenException(), 'FORBIDDEN', 403],
    [new NotFoundException('Cannot GET /x'), 'NOT_FOUND', 404],
    [new HttpException('teapot', 418), 'INVALID_REQUEST', 400],
    [new HttpException('bad gateway', 502), 'INTERNAL_ERROR', 500],
    [new HttpException('down', 503), 'SERVICE_UNAVAILABLE', 503],
  ])('maps Nest %s', (error, code, status) => {
    const resolved = resolveError(error);
    expect(resolved.code).toBe(code);
    expect(resolved.httpStatus).toBe(status);
    // Client messages come from the catalogue, never from the exception.
    expect(resolved.message).not.toMatch(/raw message|Cannot GET|teapot|bad gateway/);
  });

  it.each([
    [{ code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 }, 'PAYLOAD_TOO_LARGE'],
    [{ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400 }, 'INVALID_REQUEST'],
  ])('maps Fastify framework error %o', (error, code) => {
    expect(resolveError(Object.assign(new Error('x'), error)).code).toBe(code);
  });

  it('maps anything else to a generic internal error', () => {
    for (const thrown of [
      new Error('db password=hunter2'),
      'string',
      null,
      { code: 'ECONNRESET' },
    ]) {
      const resolved = resolveError(thrown);
      expect(resolved).toMatchObject({
        code: 'INTERNAL_ERROR',
        httpStatus: 500,
        isServerError: true,
      });
      expect(resolved.details).toBeUndefined();
      expect(resolved.message).toBe(ERROR_CATALOGUE.INTERNAL_ERROR.message);
    }
  });
});
