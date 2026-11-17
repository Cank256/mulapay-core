/**
 * Health listener for the worker and consumer processes (P9-RDY-1). Only the api role serves
 * HTTP, so without this the orchestrator has nothing to probe on the other two. It answers two
 * unauthenticated routes and nothing else:
 *
 *   GET /health         liveness: the event loop answers. 200 `{"status":"ok"}`
 *   GET /health/ready   readiness: every check passes within CHECK_TIMEOUT_MS. 200 `ready`, else
 *                       503 `not_ready`. Which check failed is logged, never returned
 *
 * It exposes no metrics, no configuration and no identifiers.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { toLoggableError } from '../common/logging/redaction';

export const HEALTH_CHECK_TIMEOUT_MS = 2000;

export interface HealthProbe {
  readonly name: string;
  /** Resolves when healthy and rejects (or resolves false) when not. */
  readonly run: () => Promise<boolean | void>;
}

export interface HealthServer {
  readonly port: number;
  close(): Promise<void>;
}

async function runProbe(probe: HealthProbe, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      probe.run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return result !== false;
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateReadiness(
  probes: readonly HealthProbe[],
  logger: Logger,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS
): Promise<boolean> {
  const results = await Promise.all(
    probes.map(async (probe) => {
      try {
        return { name: probe.name, ok: await runProbe(probe, timeoutMs) };
      } catch (error) {
        logger.warn({ check: probe.name, err: toLoggableError(error) }, 'readiness check failed');
        return { name: probe.name, ok: false };
      }
    })
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length > 0) logger.warn({ failed }, 'process not ready');
  return failed.length === 0;
}

export function startHealthServer(options: {
  readonly port: number;
  readonly host: string;
  readonly probes: readonly HealthProbe[];
  readonly logger: Logger;
  readonly timeoutMs?: number;
}): Promise<HealthServer> {
  const { probes, logger } = options;
  const send = (res: import('node:http').ServerResponse, status: number, body: object) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET') return send(res, 405, { status: 'method_not_allowed' });
    if (path === '/health') return send(res, 200, { status: 'ok' });
    if (path === '/health/ready') {
      void evaluateReadiness(probes, logger, options.timeoutMs).then((ready) =>
        send(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' })
      );
      return;
    }
    send(res, 404, { status: 'not_found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      const { port } = server.address() as AddressInfo;
      logger.info({ port }, 'health listener started');
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
