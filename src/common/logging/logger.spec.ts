import { context, trace, TraceFlags } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import { requestContext } from '../context/request-context';
import { NestPinoLogger } from './nest-logger';
import { REDACTED } from './redaction';

const config = { NODE_ENV: 'test', APP_ROLE: 'api' } as const;

describe('root logger', () => {
  // The tracing SDK registers a context manager in production; tests register one directly.
  const contextManager = new AsyncLocalStorageContextManager();
  beforeAll(() => context.setGlobalContextManager(contextManager.enable()));
  afterAll(() => {
    contextManager.disable();
    context.disable();
  });

  it('writes gateway-compatible JSON with service and role', () => {
    const { logger, lines } = captureLogs(config);
    logger.info('hello');
    expect(lines[0]).toMatchObject({
      level: 30,
      msg: 'hello',
      service: 'mulapay-core',
      role: 'api',
    });
    expect(typeof lines[0]?.time).toBe('number');
  });

  it('redacts sensitive keys in logged objects at any depth', () => {
    const { logger, raw } = captureLogs(config);
    logger.info(
      {
        request: { headers: { authorization: 'Bearer tok_live_1', cookie: 'sid=1' } },
        phone: '+256700000001',
      },
      'with secrets'
    );
    expect(raw[0]).not.toContain('tok_live_1');
    expect(raw[0]).not.toContain('sid=1');
    expect(raw[0]).not.toContain('+256700000001');
    expect(raw[0]).toContain(REDACTED);
  });

  it('adds request context fields to every line', () => {
    const { logger, lines } = captureLogs(config);
    requestContext.run({ requestId: 'req-12345678', surface: 'public', merchantId: 'm_1' }, () => {
      logger.info('inside');
    });
    logger.info('outside');
    expect(lines[0]).toMatchObject({
      requestId: 'req-12345678',
      surface: 'public',
      merchantId: 'm_1',
    });
    expect(lines[1]?.requestId).toBeUndefined();
  });

  it('adds trace_id and span_id from the active span', () => {
    const { logger, lines } = captureLogs(config);
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    };
    context.with(trace.setSpanContext(context.active(), spanContext), () => logger.info('traced'));
    expect(lines[0]).toMatchObject({ trace_id: spanContext.traceId, span_id: spanContext.spanId });
  });

  it('serializes errors through the safe error serializer', () => {
    const { logger, raw } = captureLogs(config);
    logger.error(
      { err: Object.assign(new Error('failed'), { detail: 'Key (email)=(x@y.z)' }) },
      'oops'
    );
    expect(raw[0]).toContain('"message":"failed"');
    expect(raw[0]).not.toContain('x@y.z');
  });
});

describe('NestPinoLogger', () => {
  it('maps Nest levels and context to structured lines', () => {
    const { logger, lines } = captureLogs(config, 'trace');
    const nest = new NestPinoLogger(logger);
    nest.log('started', 'Bootstrap');
    nest.warn({ detail: 'x' }, 'Ctx');
    nest.error('failed', 'stack-trace', 'Ctx');
    nest.error(new Error('boom'));
    nest.debug('dbg');
    nest.verbose('vrb');
    nest.fatal('dead');
    expect(lines.map((l) => l.level)).toEqual([30, 40, 50, 50, 20, 10, 60]);
    expect(lines[0]).toMatchObject({ msg: 'started', context: 'Bootstrap' });
    expect(lines[1]).toMatchObject({ detail: 'x', context: 'Ctx' });
    expect(lines[2]).toMatchObject({ msg: 'failed', stack: 'stack-trace', context: 'Ctx' });
    expect(lines[3]).toMatchObject({ msg: 'boom', err: { message: 'boom' } });
  });
});
