import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal stand-in for the gateway's unauthenticated readiness route. */
export interface FakeGateway {
  readonly baseUrl: string;
  readyStatus: number;
  /** When set, the server holds requests this long before answering. */
  delayMs: number;
  close(): Promise<void>;
}

export async function startFakeGateway(): Promise<FakeGateway> {
  const state = { readyStatus: 200, delayMs: 0 };
  const server: Server = createServer((req, res) => {
    const respond = () => {
      if (req.url === '/api/v1/health/ready') {
        res.writeHead(state.readyStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: state.readyStatus === 200 ? 'ready' : 'not_ready' }));
        return;
      }
      res.writeHead(404).end();
    };
    if (state.delayMs > 0) setTimeout(respond, state.delayMs);
    else respond();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get readyStatus() {
      return state.readyStatus;
    },
    set readyStatus(value: number) {
      state.readyStatus = value;
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(value: number) {
      state.delayMs = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
