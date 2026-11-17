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

#### Variable reference

Generated from `.env.example`; a unit test fails when a variable there is missing here.

**Process**

| Variable      | Example value | Meaning                                                               |
| ------------- | ------------- | --------------------------------------------------------------------- |
| `NODE_ENV`    | `development` | development \| test \| production                                     |
| `APP_ROLE`    | `api`         | api \| worker \| consumer                                             |
| `PORT`        | `4000`        | HTTP port (api role only)                                             |
| `HOST`        | `0.0.0.0`     | HTTP bind address                                                     |
| `TRUST_PROXY` | unset         | comma-separated proxy IPs/CIDRs; required in production, no wildcards |

**Database**

| Variable                  | Example value                                                   | Meaning                                                     |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`            | `postgres://mulapay_core_rw:core_rw_dev@localhost:6432/mulapay` | mulapay_core_rw via PgBouncer                               |
| `DATABASE_RO_URL`         | `postgres://mulapay_core_ro:core_ro_dev@localhost:6432/mulapay` | mulapay_core_ro, SELECT on gateway event tables             |
| `DATABASE_REPLICA_URL`    | unset                                                           | read replica for reports/analytics; unset = primary rw pool |
| `DATABASE_DIRECT_URL`     | `postgres://mulapay_core_rw:core_rw_dev@localhost:5433/mulapay` | bypasses PgBouncer: migrations and advisory locks           |
| `DB_POOL_MIN`             | `2`                                                             | minimum clients per pool                                    |
| `DB_POOL_MAX`             | `20`                                                            | maximum clients per pool                                    |
| `DB_STATEMENT_TIMEOUT_MS` | `15000`                                                         | per-transaction statement timeout                           |
| `DB_IDLE_TX_TIMEOUT_MS`   | `10000`                                                         | per-transaction idle-in-transaction timeout                 |

**Redis**

| Variable       | Example value            | Meaning                                                                 |
| -------------- | ------------------------ | ----------------------------------------------------------------------- |
| `QUEUE_PREFIX` | `mulapay-core`           | BullMQ key namespace; change it to share one Redis between environments |
| `REDIS_URL`    | `redis://localhost:6380` | cache, limits, locks, queues; never financial truth                     |
| `REDIS_TLS`    | `false`                  | true to connect with TLS                                                |

**Gateway**

| Variable                            | Example value | Meaning                                              |
| ----------------------------------- | ------------- | ---------------------------------------------------- |
| `GATEWAY_BASE_URL`                  | unset         | e.g. http://localhost:3000; required in production   |
| `GATEWAY_API_KEY`                   | unset         | key issued for tenant "core"; required in production |
| `GATEWAY_API_KEY_HEADER`            | `X-API-Key`   | header carrying the gateway key                      |
| `GATEWAY_TENANT_ID`                 | `core`        | gateway tenant id for core                           |
| `GATEWAY_TIMEOUT_MS`                | `30000`       | budget for a synchronous gateway call                |
| `GATEWAY_MAX_RETRIES`               | `2`           | retries on 429/5xx with the same externalId          |
| `GATEWAY_CIRCUIT_FAILURE_THRESHOLD` | `5`           | failures that open the circuit                       |
| `GATEWAY_CIRCUIT_RESET_MS`          | `15000`       | open -> half-open delay                              |
| `GATEWAY_EVENT_SOURCE`              | `database`    | database \| http                                     |
| `GATEWAY_EVENT_BATCH_SIZE`          | `500`         | events read per consumer loop                        |
| `GATEWAY_EVENT_LAG_SECONDS`         | `2`           | mandatory read lag; minimum 2                        |
| `GATEWAY_EVENT_POLL_MS`             | `500`         | consumer poll interval                               |
| `CONSUMER_LAG_ALERT_SECONDS`        | `60`          | consumer lag alert threshold                         |

**Auth**

| Variable                      | Example value | Meaning                                                      |
| ----------------------------- | ------------- | ------------------------------------------------------------ |
| `JWT_PRIVATE_KEY`             | unset         | Ed25519 private key PEM (\n-escaped); required in production |
| `JWT_PUBLIC_KEY`              | unset         | matching Ed25519 public key PEM; required in production      |
| `JWT_PREVIOUS_PUBLIC_KEY`     | unset         | previous public key during rotation                          |
| `JWT_KID`                     | unset         | key id placed in the JWT header; required in production      |
| `ACCESS_TOKEN_TTL`            | `600`         | access token lifetime, seconds                               |
| `REFRESH_TOKEN_TTL`           | `2592000`     | refresh token lifetime, seconds                              |
| `STEP_UP_WINDOW_SECONDS`      | `300`         | how recent a re-auth must be for step-up routes              |
| `MFA_ISSUER`                  | `MulaPay`     | TOTP issuer label                                            |
| `SIGNATURE_TOLERANCE_SECONDS` | `300`         | max clock skew for signed requests                           |

**Encryption**

| Variable              | Example value | Meaning                                                             |
| --------------------- | ------------- | ------------------------------------------------------------------- |
| `KMS_KEY_ID`          | unset         | KMS key wrapping the DEK; unset = raw local key                     |
| `DATA_ENCRYPTION_KEY` | unset         | base64 32-byte key, or wrapped DEK with KMS; required in production |
| `PII_HMAC_PEPPER`     | unset         | >= 32 chars, keys PII search HMACs; required in production          |

**Rate limits**

| Variable                             | Example value | Meaning                                      |
| ------------------------------------ | ------------- | -------------------------------------------- |
| `RATE_LIMIT_WRITE_PER_MIN`           | `100`         | per API key, writes                          |
| `RATE_LIMIT_READ_PER_MIN`            | `600`         | per API key, reads                           |
| `RATE_LIMIT_PAYOUT_PER_MIN`          | `60`          | per merchant, payouts                        |
| `RATE_LIMIT_BURST_CAPACITY`          | `20`          | per API key, token bucket capacity           |
| `RATE_LIMIT_BURST_REFILL_PER_SECOND` | `10`          | per API key, token bucket refill             |
| `RATE_LIMIT_AUTH_FAILURE_PER_MIN`    | `30`          | failed API key authentications per client IP |

**Developer platform**

| Variable                          | Example value | Meaning                                                                      |
| --------------------------------- | ------------- | ---------------------------------------------------------------------------- |
| `WEBHOOK_ALLOW_PRIVATE_NETWORKS`  | `false`       | true lets webhooks reach private IPs (local dev only; refused in production) |
| `SANDBOX_PENDING_SECONDS`         | `5`           | sandbox: delay before pending_then_succeed resolves                          |
| `SANDBOX_TIMEOUT_RESOLVE_SECONDS` | `120`         | sandbox: delay before a simulated timeout expires                            |

**Business policy**

| Variable                            | Example value | Meaning                                                                   |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `DEFAULT_CURRENCY`                  | `UGX`         | ISO 4217 default currency                                                 |
| `PAYMENT_EXPIRY_MINUTES`            | `15`          | default payment expiry                                                    |
| `HOLD_DEFAULT_EXPIRY_MINUTES`       | `60`          | default hold expiry                                                       |
| `PAYOUT_APPROVAL_THRESHOLD_MINOR`   | `5000000`     | payouts above this need approval (minor units)                            |
| `REFUND_APPROVAL_THRESHOLD_MINOR`   | `5000000`     | refunds above this need approval (minor units)                            |
| `SETTLEMENT_DEFAULT_DELAY_DAYS`     | `1`           | settlement delay                                                          |
| `SETTLEMENT_MIN_PAYOUT_MINOR`       | `10000`       | below this a batch rolls into the next cycle (minor units)                |
| `ROLLING_RESERVE_BPS`               | `0`           | default rolling reserve, basis points                                     |
| `RECON_STALE_MINUTES`               | `10`          | age before a processing transaction is chased                             |
| `RECON_GAP_INTERVAL_SECONDS`        | `300`         | gateway gap reconciliation interval                                       |
| `SUSPENSE_ALERT_HOURS`              | `1`           | non-zero suspense alert threshold                                         |
| `ROLLING_RESERVE_HOLD_DAYS`         | `30`          | default days a rolling reserve is held when a merchant has no own setting |
| `SETTLEMENT_RELEASE_RETRY_SECONDS`  | `60`          | age at which a releasing batch is re-driven or its payout status verified |
| `RECON_STATEMENT_DATE_WINDOW_HOURS` | `48`          | statement rows match a transaction completed within this many hours       |
| `RECON_BALANCE_TOLERANCE_MINOR`     | `0`           | allowed difference between ledger and gateway balances (minor units)      |
| `RECON_RUN_LEASE_SECONDS`           | `900`         | a running reconciliation run past this belongs to a dead worker           |
| `RECON_GATEWAY_LOOKUPS_PER_RUN`     | `200`         | gateway status lookups one gap run may make                               |

**Storage**

| Variable                       | Example value | Meaning                                                            |
| ------------------------------ | ------------- | ------------------------------------------------------------------ |
| `S3_ENDPOINT`                  | unset         | S3-compatible endpoint                                             |
| `S3_REGION`                    | unset         | bucket region                                                      |
| `S3_BUCKET_DOCUMENTS`          | unset         | KYC documents bucket                                               |
| `S3_BUCKET_REPORTS`            | unset         | generated reports bucket                                           |
| `S3_ACCESS_KEY_ID`             | unset         | storage access key id                                              |
| `S3_SECRET_ACCESS_KEY`         | unset         | storage secret                                                     |
| `PRESIGN_UPLOAD_TTL_SECONDS`   | `900`         | presigned PUT lifetime                                             |
| `PRESIGN_DOWNLOAD_TTL_SECONDS` | `900`         | presigned GET lifetime (KYC document views are capped at 300)      |
| `S3_FORCE_PATH_STYLE`          | `false`       | true for MinIO and other path-style S3 stores                      |
| `S3_SERVER_SIDE_ENCRYPTION`    | unset         | AES256 \| aws:kms; required in production with S3_BUCKET_DOCUMENTS |

**Notifications**

| Variable               | Example value | Meaning                       |
| ---------------------- | ------------- | ----------------------------- |
| `EMAIL_PROVIDER`       | unset         | ses \| postmark \| resend     |
| `EMAIL_API_KEY`        | unset         | email provider credential     |
| `EMAIL_FROM`           | unset         | sender address                |
| `SMS_PROVIDER`         | unset         | africastalking \| twilio      |
| `SMS_API_KEY`          | unset         | SMS provider credential       |
| `SMS_SENDER_ID`        | unset         | SMS sender id                 |
| `FCM_PROJECT_ID`       | unset         | Firebase project for push     |
| `FCM_CREDENTIALS_JSON` | unset         | Firebase service account JSON |

**Compliance**

| Variable                       | Example value       | Meaning                                                |
| ------------------------------ | ------------------- | ------------------------------------------------------ |
| `SANCTIONS_PROVIDER`           | unset               | opensanctions \| complyadvantage                       |
| `SANCTIONS_API_KEY`            | unset               | sanctions provider credential                          |
| `SANCTIONS_LISTS`              | `UN,OFAC,EU,UK,PEP` | lists screened against                                 |
| `SANCTIONS_BASE_URL`           | unset               | override of the provider API base URL                  |
| `SANCTIONS_TIMEOUT_MS`         | `5000`              | per screening request                                  |
| `AML_SCREENING_REVIEW_SCORE`   | `0.7`               | a hit at or above this score needs an analyst decision |
| `AML_SCREENING_CONFIRM_SCORE`  | `0.9`               | a hit at or above this score is a confirmed match      |
| `AML_ALERT_SLA_HOURS_LOW`      | `72`                | hours before an unworked low alert escalates           |
| `AML_ALERT_SLA_HOURS_MEDIUM`   | `24`                | ... medium                                             |
| `AML_ALERT_SLA_HOURS_HIGH`     | `8`                 | ... high                                               |
| `AML_ALERT_SLA_HOURS_CRITICAL` | `4`                 | ... critical                                           |
| `KYC_VALIDITY_DAYS`            | `365`               | how long an approved KYC stays valid                   |
| `KYC_REVERIFY_NOTICE_DAYS`     | `30`                | re-verification notice period before expiry            |

**CORS**

| Variable                 | Example value | Meaning                                   |
| ------------------------ | ------------- | ----------------------------------------- |
| `CORS_DASHBOARD_ORIGINS` | unset         | comma-separated origins for /dashboard/v1 |
| `CORS_ADMIN_ORIGINS`     | unset         | comma-separated origins for /admin/v1     |

**Observability**

| Variable                 | Example value | Meaning                                                    |
| ------------------------ | ------------- | ---------------------------------------------------------- |
| `LOG_LEVEL`              | `info`        | fatal \| error \| warn \| info \| debug \| trace \| silent |
| `ENABLE_TELEMETRY`       | `false`       | export OpenTelemetry traces                                |
| `TELEMETRY_ENDPOINT`     | unset         | OTLP/HTTP collector URL; required when telemetry is on     |
| `TELEMETRY_SAMPLE_RATIO` | `1`           | head sampling ratio, 0..1                                  |
| `METRICS_TOKEN`          | unset         | >= 24 chars; enables GET /metrics with Bearer auth         |
| `ENABLE_API_DOCS`        | `true`        | serve /docs/{surface}; refused in production               |

**Notifications, reports, support and operations**

| Variable                          | Example value | Meaning                                                                          |
| --------------------------------- | ------------- | -------------------------------------------------------------------------------- |
| `EMAIL_BASE_URL`                  | unset         | override the email vendor's API base (tests, proxies)                            |
| `SMS_BASE_URL`                    | unset         | override the SMS vendor's API base                                               |
| `SMS_USERNAME`                    | unset         | Africa's Talking account username                                                |
| `FCM_BASE_URL`                    | unset         | override the FCM API base                                                        |
| `NOTIFICATION_TIMEOUT_MS`         | `10000`       | one delivery attempt to a vendor                                                 |
| `NOTIFICATION_MAX_ATTEMPTS`       | `6`           | attempts per delivery before it is marked failed                                 |
| `NOTIFICATION_RETRY_BASE_SECONDS` | `30`          | first retry delay; doubles each attempt                                          |
| `REPORT_MAX_ROWS`                 | `5000000`     | a report stops with REPORT_TOO_LARGE past this many rows                         |
| `REPORT_MAX_ACTIVE_PER_MERCHANT`  | `5`           | queued or running reports one merchant may have                                  |
| `REPORT_CURSOR_BATCH_SIZE`        | `1000`        | rows fetched from the database cursor at a time                                  |
| `REPORT_MULTIPART_PART_BYTES`     | `5242880`     | size of each uploaded part (S3 minimum 5 MiB)                                    |
| `REPORT_SCHEDULE_MAX_FAILURES`    | `5`           | consecutive failures before a schedule turns itself off                          |
| `DISPUTE_DEADLINE_WARNING_HOURS`  | `48`          | staff are told this long before a dispute's evidence deadline                    |
| `OPS_STUCK_TXN_MINUTES`           | `15`          | a processing transaction older than this is stuck (incident after the same time) |
| `OPS_STUCK_TXN_SEV2_MINUTES`      | `60`          | stuck for this long is sev2                                                      |
| `OPS_QUEUE_DEPTH_THRESHOLD`       | `1000`        | queue depth that opens an incident when it lasts                                 |
| `OPS_QUEUE_DEPTH_SUSTAIN_SECONDS` | `300`         | how long a queue must stay above the threshold                                   |
| `OPS_SUSPENSE_SEV1_HOURS`         | `24`          | a non-zero suspense balance this old is sev1 (sev2 from SUSPENSE_ALERT_HOURS)    |
| `OPS_MONITOR_INTERVAL_SECONDS`    | `60`          | how often the automatic incident monitors look                                   |
| `OPS_FLAG_CHANGE_APPROVAL`        | `production`  | production \| always \| never: when a feature flag change needs approval         |
| `APPROVAL_TTL_HOURS`              | `24`          | a pending approval expires after this long                                       |
| `MAINTENANCE_RETRY_AFTER_SECONDS` | `60`          | default Retry-After while maintenance mode is on                                 |

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
