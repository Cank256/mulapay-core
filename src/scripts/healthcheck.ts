/**
 * Container HEALTHCHECK (`node dist/scripts/healthcheck.js`). The distroless runtime has no shell
 * or curl, so the probe is a few lines of Node. It reads only APP_ROLE, PORT and HEALTH_PORT, and
 * checks liveness (not readiness): a transient Redis or database outage must not restart a
 * container. Exit 0 healthy, 1 not.
 */
import { get } from 'node:http';

export function healthcheckTarget(env: NodeJS.ProcessEnv): { port: number; path: string } {
  const role = env.APP_ROLE ?? 'api';
  if (role === 'api') return { port: Number(env.PORT ?? 4000), path: '/v1/health' };
  return { port: Number(env.HEALTH_PORT ?? 4001), path: '/health' };
}

export function probe(env: NodeJS.ProcessEnv, timeoutMs = 3000): Promise<boolean> {
  const { port, path } = healthcheckTarget(env);
  return new Promise((resolve) => {
    const request = get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

if (require.main === module) {
  void probe(process.env).then((ok) => process.exit(ok ? 0 : 1));
}
