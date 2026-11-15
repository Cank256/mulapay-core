/**
 * What the rate limiter does when Redis is unreachable (spec 8.5, 11): reads are let
 * through, writes are refused, and a signed request is never accepted without replay
 * protection.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { SignatureReplayStore } from '../auth/signature-replay.store';
import { AppError } from '../errors/app-error';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimiter } from './rate-limiter';

const CONFIG = {
  RATE_LIMIT_WRITE_PER_MIN: 100,
  RATE_LIMIT_READ_PER_MIN: 600,
  RATE_LIMIT_PAYOUT_PER_MIN: 60,
  RATE_LIMIT_BURST_CAPACITY: 20,
  RATE_LIMIT_BURST_REFILL_PER_SECOND: 10,
};
const PRINCIPAL = {
  kind: 'api_key',
  apiKeyId: 'key-1',
  merchant: { id: 'm-1', ref: 'mch_1', status: 'active' },
  environment: 'live',
  rateLimitRpm: null,
};

function contextFor(method: string, principal: unknown): ExecutionContext {
  const headers: Record<string, string> = {};
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ method, principal }),
      getResponse: () => ({
        header: (name: string, value: string) => {
          headers[name] = value;
          return undefined;
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(consume: RateLimiter['consume']): RateLimitGuard {
  const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
  return new RateLimitGuard(
    reflector,
    { consume } as RateLimiter,
    CONFIG,
    pino({ level: 'silent' })
  );
}

describe('RateLimitGuard when Redis is down', () => {
  const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

  it('lets a read through', async () => {
    await expect(guardWith(down).canActivate(contextFor('GET', PRINCIPAL))).resolves.toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a %s with 503, not by guessing',
    async (method) => {
      const error = await guardWith(down)
        .canActivate(contextFor(method, PRINCIPAL))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('SERVICE_UNAVAILABLE');
    }
  );

  it('ignores requests that are not API key requests', async () => {
    await expect(guardWith(down).canActivate(contextFor('POST', undefined))).resolves.toBe(true);
    await expect(
      guardWith(down).canActivate(contextFor('POST', { kind: 'merchant_user' }))
    ).resolves.toBe(true);
  });

  it('sends the limit headers and a 429 when the limiter refuses', async () => {
    const refuse = vi.fn().mockResolvedValue({
      allowed: false,
      scope: 'key_write',
      limit: 5,
      remaining: 0,
      resetAtSeconds: 1_900_000_000,
      retryAfterSeconds: 7,
    });
    const error = await guardWith(refuse)
      .canActivate(contextFor('POST', PRINCIPAL))
      .catch((e: unknown) => e);
    expect((error as AppError).code).toBe('RATE_LIMITED');
    expect((error as AppError).retryAfterSeconds).toBe(7);
  });
});

describe('SignatureReplayStore when Redis is down', () => {
  it('fails closed: a signed request is never accepted without replay protection', async () => {
    const store = new SignatureReplayStore(
      { set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as never,
      { SIGNATURE_TOLERANCE_SECONDS: 300 }
    );
    const error = await store.claim('key', 'a'.repeat(64)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('remembers a signature for twice the tolerance', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const store = new SignatureReplayStore({ set } as never, { SIGNATURE_TOLERANCE_SECONDS: 300 });
    expect(await store.claim('key', 'b'.repeat(64))).toBe(true);
    expect(set).toHaveBeenCalledWith(`sigreplay:key:${'b'.repeat(64)}`, '1', 'EX', 605, 'NX');
    set.mockResolvedValue(null);
    expect(await store.claim('key', 'b'.repeat(64))).toBe(false);
  });
});
