/**
 * A stand-in for the gateway endpoints Phase 6 calls (spec 3.2), speaking the real response
 * shapes (`provider_gateway/src/schemas/payment.ts`, `routes/transaction.ts`): disbursement,
 * lookup by external id, the operation list and the provider balance. The core adapter talks
 * to it over real HTTP, so the adapter is exercised too.
 *
 * A test scripts what the gateway does with `disbursement`, and may create operations the
 * core never asked for with `addOperation` (a lost core record).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_GATEWAY_KEY = 'test-gateway-key-0123456789';

export type GatewayStatus =
  'pending' | 'unknown' | 'successful' | 'failed' | 'expired' | 'cancelled';

export interface FakeOperation {
  providerId: string;
  operationType: 'collection' | 'disbursement' | 'refund';
  referenceId: string;
  externalId: string;
  status: GatewayStatus;
  amount: string;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DisbursementBehaviour =
  /** 201 with a pending operation. */
  | { kind: 'accept'; status?: GatewayStatus }
  /** The request is recorded by the gateway, then the answer is a 504 (outcome unknown). */
  | { kind: 'gateway_timeout' }
  /** The gateway answers with this status and records nothing. */
  | { kind: 'status'; code: number }
  /** The connection is dropped after the gateway recorded the operation. */
  | { kind: 'drop' };

export interface FakeGatewayOps {
  readonly baseUrl: string;
  disbursement: DisbursementBehaviour;
  /** Overrides the by-external-id answer: a status code, or undefined for the real lookup. */
  lookupStatus: number | undefined;
  listFails: boolean;
  readonly disbursementCalls: {
    externalId: string;
    amount: string;
    currency: string;
    provider: string;
    auth: string | undefined;
  }[];
  readonly operations: Map<string, FakeOperation>;
  setBalance(
    provider: string,
    accountType: 'collection' | 'disbursement',
    currency: string,
    amount: string
  ): void;
  addOperation(
    op: Partial<FakeOperation> & Pick<FakeOperation, 'externalId' | 'operationType'>
  ): FakeOperation;
  setStatus(
    externalId: string,
    operationType: FakeOperation['operationType'],
    status: GatewayStatus
  ): void;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

const pad = (amount: string): string => (amount.includes('.') ? amount : `${amount}.0000`);

export async function startFakeGatewayOps(): Promise<FakeGatewayOps> {
  const operations = new Map<string, FakeOperation>();
  const balances = new Map<string, string>();
  let counter = 0;
  const key = (type: string, externalId: string) => `${type}:${externalId}`;
  const sanitize = (o: FakeOperation) => ({
    id: o.referenceId,
    providerId: o.providerId,
    operationType: o.operationType,
    referenceId: o.referenceId,
    externalId: o.externalId,
    status: o.status,
    amount: pad(o.amount),
    currency: o.currency,
    reason: null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  });

  const state: FakeGatewayOps = {
    baseUrl: '',
    disbursement: { kind: 'accept' },
    lookupStatus: undefined,
    listFails: false,
    disbursementCalls: [],
    operations,
    setBalance(provider, accountType, currency, amount) {
      balances.set(`${provider}:${accountType}:${currency}`, amount);
    },
    addOperation(op) {
      counter += 1;
      const now = new Date();
      const full: FakeOperation = {
        providerId: 'airtel',
        referenceId: `ref-${counter}-${op.externalId}`,
        status: 'pending',
        amount: '1000',
        currency: 'TZS',
        createdAt: now,
        updatedAt: now,
        ...op,
      };
      operations.set(key(full.operationType, full.externalId), full);
      return full;
    },
    setStatus(externalId, operationType, status) {
      const op = operations.get(key(operationType, externalId));
      if (!op) throw new Error(`no fake operation ${operationType}:${externalId}`);
      op.status = status;
      op.updatedAt = new Date();
    },
    close: () => Promise.resolve(),
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const auth = req.headers['x-api-key'] as string | undefined;
      if (auth !== FAKE_GATEWAY_KEY) {
        send(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'bad key' } });
        return;
      }
      const disbursement = /^\/api\/v1\/payment\/([a-z]+)\/disbursement$/.exec(url.pathname);
      if (req.method === 'POST' && disbursement) {
        const body = await readJson(req);
        const provider = disbursement[1] as string;
        const externalId = String(body.externalId);
        state.disbursementCalls.push({
          externalId,
          amount: String(body.amount),
          currency: String(body.currency),
          provider,
          auth,
        });
        const behaviour = state.disbursement;
        if (behaviour.kind === 'status') {
          send(res, behaviour.code, { success: false, error: { code: 'X', message: 'scripted' } });
          return;
        }
        const existing = operations.get(key('disbursement', externalId));
        const op =
          existing ??
          state.addOperation({
            externalId,
            operationType: 'disbursement',
            providerId: provider,
            amount: String(body.amount),
            currency: String(body.currency),
            status: behaviour.kind === 'accept' ? (behaviour.status ?? 'pending') : 'unknown',
          });
        if (behaviour.kind === 'drop') {
          req.socket.destroy();
          return;
        }
        if (behaviour.kind === 'gateway_timeout') {
          send(res, 504, {
            success: false,
            error: {
              code: 'GATEWAY_TIMEOUT',
              message: 'Provider outcome unknown.',
              details: {
                operationId: op.referenceId,
                externalId,
                referenceId: op.referenceId,
                status: 'unknown',
              },
            },
          });
          return;
        }
        send(res, existing ? 200 : 201, {
          success: true,
          data: {
            referenceId: op.referenceId,
            status: op.status,
            externalId,
            amount: pad(op.amount),
            currency: op.currency,
            payee: body.payee,
            createdAt: op.createdAt.toISOString(),
            updatedAt: op.updatedAt.toISOString(),
          },
        });
        return;
      }
      const lookup = /^\/api\/v1\/transaction\/by-external-id\/(.+)$/.exec(url.pathname);
      if (req.method === 'GET' && lookup) {
        if (state.lookupStatus !== undefined) {
          send(res, state.lookupStatus, {
            success: false,
            error: { code: 'X', message: 'scripted' },
          });
          return;
        }
        const externalId = decodeURIComponent(lookup[1] as string);
        const type = url.searchParams.get('operationType');
        const found = [...operations.values()].filter(
          (o) => o.externalId === externalId && (!type || o.operationType === type)
        );
        if (found.length === 0) {
          send(res, 404, {
            success: false,
            error: { code: 'NOT_FOUND', message: 'Transaction not found' },
          });
          return;
        }
        send(res, 200, { success: true, data: { operation: sanitize(found[0] as FakeOperation) } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/transaction') {
        if (state.listFails) {
          send(res, 503, { success: false, error: { code: 'X', message: 'down' } });
          return;
        }
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const all = [...operations.values()].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        );
        send(res, 200, {
          success: true,
          data: {
            operations: all.slice(offset, offset + limit).map(sanitize),
            pagination: { total: all.length, limit, offset },
          },
        });
        return;
      }
      const balance = /^\/api\/v1\/payment\/([a-z]+)\/balance$/.exec(url.pathname);
      if (req.method === 'GET' && balance) {
        const accountType = url.searchParams.get('accountType') ?? 'collection';
        const entry = [...balances.entries()].find(([k]) =>
          k.startsWith(`${balance[1]}:${accountType}:`)
        );
        if (!entry) {
          send(res, 503, { success: false, error: { code: 'X', message: 'no balance scripted' } });
          return;
        }
        const [, , currency] = entry[0].split(':');
        send(res, 200, {
          success: true,
          data: { availableBalance: pad(entry[1]), currency, accountType },
        });
        return;
      }
      send(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'no route' } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
