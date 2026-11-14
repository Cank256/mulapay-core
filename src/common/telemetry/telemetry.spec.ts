import { describe, expect, it } from 'vitest';
import { isAuthorizedMetricsRequest } from './metrics-auth';
import { sanitizeSpanAttributes } from './span-sanitizer';
import { resolveTracesUrl, startTracing } from './tracing';

const TOKEN = 'metrics-token-0123456789abcdef';

describe('isAuthorizedMetricsRequest', () => {
  it('accepts only the exact bearer token', () => {
    expect(isAuthorizedMetricsRequest(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorizedMetricsRequest(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorizedMetricsRequest(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorizedMetricsRequest('Bearer ', TOKEN)).toBe(false);
    expect(isAuthorizedMetricsRequest(undefined, TOKEN)).toBe(false);
  });
});

describe('sanitizeSpanAttributes', () => {
  it('redacts secret query parameters in URL attributes', () => {
    const attributes: Record<string, unknown> = {
      'url.full': 'https://core/x?token=abc&a=1',
      'url.query': 'api_key=k',
      'http.method': 'GET',
      'url.path': 42,
    };
    sanitizeSpanAttributes(attributes);
    expect(attributes['url.full']).toBe('https://core/x?token=[REDACTED]&a=1');
    expect(attributes['url.query']).toBe('api_key=[REDACTED]');
    expect(attributes['http.method']).toBe('GET');
    expect(attributes['url.path']).toBe(42);
  });
});

describe('tracing', () => {
  it('resolves the OTLP traces path for bare collector URLs', () => {
    expect(resolveTracesUrl('http://collector:4318')).toBe('http://collector:4318/v1/traces');
    expect(resolveTracesUrl('http://collector:4318/custom')).toBe('http://collector:4318/custom');
  });

  it('does not start when telemetry is disabled', () => {
    expect(
      startTracing({
        ENABLE_TELEMETRY: false,
        TELEMETRY_ENDPOINT: undefined,
        TELEMETRY_SAMPLE_RATIO: 1,
        APP_ROLE: 'api',
        NODE_ENV: 'test',
      })
    ).toBe(false);
  });
});
