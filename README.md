# MulaPay Core API

The service that owns money, merchants and compliance for MulaPay. Provider communication
(MTN, Airtel, Flutterwave) belongs to the separate Provider Gateway in
`../provider_gateway`.

The master specification is [docs/CORE_API_BUILD_PROMPT.md](docs/CORE_API_BUILD_PROMPT.md).
Engineering rules are in [AGENTS.md](AGENTS.md).

**Status: Phase 8 (support and operations).** Identity and merchants, the ledger, payments and transactions,
the developer platform, settlement and reconciliation, compliance, and now complaints, incidents with a public status feed,
notifications, async reports, rollups and analytics, and the operations surface. The Provider Gateway client and the
event consumer (Phases 3 and 4) are not built. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what is in place, what comes next and
the decisions awaiting confirmation, and [docs/SECURITY.md](docs/SECURITY.md) for the
auth model.

## Requirements

- Node.js 22 (`.nvmrc`)
- Docker, for the local stack and for the integration tests (Testcontainers)

## Local setup

```bash
npm ci
cp .env.example .env            # values match docker-compose.yml
docker compose up -d            # Postgres 16, PgBouncer, Redis 7
npm run db:migrate              # applies src/db/migrations to the core schema
npm run dev                     # API on http://localhost:4000
```

Check it:

```bash
curl localhost:4000/v1/health          # {"status":"ok"}
curl localhost:4000/v1/health/ready    # {"status":"ready"}
open http://localhost:4000/docs/public/
```

The worker and consumer are separate processes:

```bash
npm run dev:worker
npm run dev:consumer            # only one may run; a second exits (advisory lock)
```

To run the processes in containers as well: `docker compose --profile app up --build`.

### Local ports

| Service   | Host port | Notes                                               |
| --------- | --------- | --------------------------------------------------- |
| api       | 4000      |                                                     |
| postgres  | 5433      | direct connection; `DATABASE_DIRECT_URL`            |
| pgbouncer | 6432      | transaction mode; `DATABASE_URL`, `DATABASE_RO_URL` |
| redis     | 6380      |                                                     |

Ports differ from the gateway's compose file so both stacks can run at once.

On first start the Postgres container runs
[src/db/bootstrap/001_core_roles_and_schema.sql](src/db/bootstrap/001_core_roles_and_schema.sql),
which creates the `mulapay_core_rw` and `mulapay_core_ro` roles and the `core` schema.
To start from scratch: `docker compose down -v`.

### Environment

Every variable is listed in [.env.example](.env.example) and validated at boot by
[src/config/env.schema.ts](src/config/env.schema.ts). The process exits with a list of
failing variables (never their values) if anything is invalid. In `.env` files an
unquoted `#` starts a comment, so quote values that contain one.

`/metrics` is registered only when `METRICS_TOKEN` (24+ characters) is set:

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:4000/metrics
```

## Commands

| Command                                       | Purpose                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| `npm run dev` / `dev:worker` / `dev:consumer` | Run a process with watch                                       |
| `npm run build`                               | Compile to `dist/` (includes migrations and bootstrap SQL)     |
| `npm run start`                               | Run `dist/main.js`; `APP_ROLE` selects api, worker or consumer |
| `npm run test:load`                           | Load against the spec 9.1 targets; needs a quiet machine       |
| `npm run typecheck`                           | TypeScript, strict                                             |
| `npm run lint` / `lint:fix`                   | ESLint, zero warnings allowed                                  |
| `npm run format` / `format:check`             | Prettier                                                       |
| `npm test`                                    | Unit and integration suites                                    |
| `npm run test:unit`                           | Unit suite only, no Docker needed                              |
| `npm run test:integration`                    | Integration suite (starts Postgres and Redis containers)       |
| `npm run test:coverage`                       | Both suites with coverage gates                                |
| `npm run db:generate`                         | `drizzle-kit generate` from `src/db/schema`                    |
| `npm run db:migrate`                          | Apply migrations (uses `DATABASE_DIRECT_URL`)                  |
| `npm run db:studio`                           | Drizzle Studio                                                 |
| `npm run openapi:export`                      | Write `docs/openapi/{public,dashboard,admin}.json`             |
| `npm run seed:admin -- --email E --name N`    | Bootstrap a staff user; prints a password and TOTP URI once    |

`test:load`, `db:seed` and `gateway:verify` arrive with the phases that need them.

The API needs `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID` and `DATA_ENCRYPTION_KEY` for
logins and MFA. For local development:

```bash
openssl genpkey -algorithm ed25519 -out jwt.pem          # *.pem is git-ignored
openssl pkey -in jwt.pem -pubout -out jwt.pub.pem
# put both into .env with literal \n line breaks, plus JWT_KID=local-1
openssl rand -base64 32                                  # DATA_ENCRYPTION_KEY
```

### Testcontainers and Docker contexts

The integration suite needs a Docker socket. With Docker Desktop's default socket nothing
is needed. With OrbStack or Colima, point Testcontainers at the socket:

```bash
export DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock
```

## Production image

```bash
docker build --target runtime -t mulapay-core .
docker run --read-only -e APP_ROLE=api ... mulapay-core          # api | worker | consumer
docker run --read-only ... mulapay-core dist/db/migrate.js       # migrations
```

The runtime stage is distroless Node 22: no shell, runs as `nonroot`, production
dependencies only. Probe `/v1/health` (liveness) and `/v1/health/ready` (readiness) on api
containers.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): processes, layering, request lifecycle, Phase 0 decisions
- [docs/DATABASE.md](docs/DATABASE.md): schema, roles, grants, migration workflow
- [docs/OPERATIONS.md](docs/OPERATIONS.md): runbooks, executed by `test/integration/runbooks.int-spec.ts`
- [docs/LOAD_RESULTS.md](docs/LOAD_RESULTS.md): the spec 9.1 targets and what was measured (`npm run test:load`)
- [docs/SECURITY.md](docs/SECURITY.md): authentication, sessions, MFA, authorization, API keys
- [docs/query-plans/](docs/query-plans/README.md): committed plans for the hot queries
- [docs/GATEWAY_INTEGRATION.md](docs/GATEWAY_INTEGRATION.md): differences between the spec and the gateway code
