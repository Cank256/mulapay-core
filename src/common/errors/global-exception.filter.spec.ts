import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from './app-error';
import { GlobalExceptionFilter } from './global-exception.filter';

function run(exception: unknown) {
  const headers: Record<string, string> = {};
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    sent: false,
    header: (name: string, value: string) => {
      headers[name] = value;
      return reply;
    },
    status: (code: number) => {
      sent.status = code;
      return reply;
    },
    type: () => reply,
    send: (body: unknown) => {
      sent.body = body;
      return reply;
    },
  };
  const request = { id: 'req_1', method: 'POST', routeOptions: { url: '/v1/payments' } };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
  new GlobalExceptionFilter(logger).catch(exception, host);
  return { headers, sent, logger };
}

describe('GlobalExceptionFilter', () => {
  it('answers an exhausted connection pool with 503 and Retry-After, not 500', () => {
    const { headers, sent, logger } = run(new Error('timeout exceeded when trying to connect'));
    expect(sent.status).toBe(503);
    expect(headers['Retry-After']).toBe('5');
    expect(sent.body).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(JSON.stringify(sent.body)).not.toContain('timeout exceeded');
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
  it('still answers an unknown failure with 500 and no Retry-After', () => {
    const { headers, sent } = run(new Error('boom'));
    expect(sent.status).toBe(500);
    expect(headers['Retry-After']).toBeUndefined();
  });
  it('keeps the Retry-After of an AppError', () => {
    const { headers, sent } = run(new AppError('SERVICE_UNAVAILABLE', { retryAfterSeconds: 12 }));
    expect(sent.status).toBe(503);
    expect(headers['Retry-After']).toBe('12');
  });
});
