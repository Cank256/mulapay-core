/**
 * Gateway readiness probe: `GET {GATEWAY_BASE_URL}/api/v1/health/ready` (spec 3.2).
 *
 * The gateway's health routes are unauthenticated, so no API key is sent. This is the
 * only gateway call in Phase 0; the full client with retries, the circuit breaker and
 * ambiguous-outcome handling arrives in Phase 3.
 */
import { Inject, Injectable } from '@nestjs/common';
import { request } from 'undici';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../common/tokens';

export type GatewayReadiness = 'up' | 'down' | 'not_configured';

@Injectable()
export class GatewayHealthClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async checkReady(timeoutMs: number): Promise<GatewayReadiness> {
    const base = this.config.GATEWAY_BASE_URL;
    if (!base) return 'not_configured';
    const url = new URL('/api/v1/health/ready', base);
    const response = await request(url, {
      method: 'GET',
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the socket returns to the pool.
    await response.body.dump();
    return response.statusCode === 200 ? 'up' : 'down';
  }
}
