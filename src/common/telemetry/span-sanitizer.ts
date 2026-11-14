/**
 * Scrubs secret-looking query parameters from span URL attributes before export,
 * following the gateway's SanitizingSpanExporter.
 */
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { redactUrl } from '../logging/redaction';

const URL_ATTRIBUTES = ['http.url', 'http.target', 'url.full', 'url.path', 'url.query'];

export function sanitizeSpanAttributes(attributes: Record<string, unknown>): void {
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value !== 'string') continue;
    attributes[key] = key === 'url.query' ? redactUrl(`?${value}`)?.slice(1) : redactUrl(value);
  }
}

export class SanitizingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      sanitizeSpanAttributes(span.attributes);
    }
    this.inner.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}
