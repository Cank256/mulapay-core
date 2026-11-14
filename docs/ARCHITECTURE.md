# Architecture

Status: Phase 0 (foundation). This document grows with each phase. The specification is
[CORE_API_BUILD_PROMPT.md](CORE_API_BUILD_PROMPT.md).

## Processes

One codebase and one image; `APP_ROLE` picks the process (spec 4.1).

| Role       | Entry point            | Root module      | Does                                                             |
| ---------- | ---------------------- | ---------------- | ---------------------------------------------------------------- |
| `api`      | `src/main.api.ts`      | `AppModule`      | HTTP only. No workers, no pollers. Scales horizontally.          |
| `worker`   | `src/main.worker.ts`   | `WorkerModule`   | BullMQ workers for processors registered in `src/jobs`. No HTTP. |
| `consumer` | `src/main.consumer.ts` | `ConsumerModule` | Gateway event consumer and schedules (Phase 3). Singleton.       |

`src/main.ts` dispatches on `APP_ROLE` for `npm run start`.

Each entry point first imports `src/common/telemetry/register.ts`, which loads `.env`,
validates the configuration (exit 1 on failure) and starts tracing before `http`, `pg`,
`ioredis` and `undici` are loaded.

The consumer takes `pg_try_advisory_lock(hashtext('core:gateway-event-consumer'))` on a
dedicated direct connection before anything else, and exits with status 1 if another
instance holds it. The lock is re-verified every 5 seconds; if the connection drops or
the lock disappears, the process exits immediately (`src/common/db/advisory-lock.ts`).

## Source layout

```
src/
  main*.ts, app.module.ts, worker.module.ts, consumer.module.ts
  bootstrap/        HTTP app factory (shared by main, tests and OpenAPI export), process runner
  config/           Zod env schema, config loading
  common/
    context/        AsyncLocalStorage request context (requestId, surface, actor)
    clock/          injectable clock (tests use test/support/fixed-clock.ts)
    db/             pools (rw, ro, replica), UnitOfWork, singleton advisory lock
    errors/         error catalogue, AppError, envelope, exception filter
    health/         /v1/health, /v1/health/ready
    http/           request ids, envelope interceptor, response schemas, CORS, headers, hooks
    logging/        Pino root logger, redaction, Nest logger adapter
    openapi/        per-surface documents, Scalar docs
    queue/          queue catalogue, registry, worker host, dead-letter path
    redis/          ioredis connections
    telemetry/      OpenTelemetry tracing, Prometheus metrics, /metrics
  db/
    schema/         Drizzle schema root (core pgSchema; no tables yet)
    migrations/     drizzle-kit migrations
    bootstrap/      DBA-run SQL: roles, schema, gateway read grants
    migrator.ts     migration runner (see DATABASE.md)
  integrations/gateway/   readiness probe only (full client in Phase 3)
  surfaces/         public (/v1), dashboard (/dashboard/v1), admin (/admin/v1): empty modules
  jobs/             BullMQ processor registry (empty)
  consumers/        gateway event consumer (lock name only)
test/
  integration/      Testcontainers suites and global setup
  support/          test config, app factory, log capture, fake gateway, fixed clock
  fixtures/         stand-in gateway tables for grant tests
```

`src/modules/*` (the 23 domains) does not exist yet; each phase adds its modules.

## Layering

```
controller -> application service -> domain service -> repository -> Drizzle
```

Controllers validate, authorize and map shapes. Application services own the use case
and the transaction (`UnitOfWork.run`). Domain services own invariants. Repositories own
SQL. No outbound HTTP, S3 or queue call happens inside a transaction (spec 4.3, 9.2).

## Request lifecycle (api)

1. **Request id.** `genReqId` accepts `X-Request-Id` if it matches `[A-Za-z0-9._:-]{8,128}`,
   otherwise generates a UUID. It is echoed on every response, including errors.
2. **Context.** An `onRequest` hook opens an AsyncLocalStorage context with `requestId`
   and `surface`. Every log line written during the request carries them, plus `trace_id`
   and `span_id` from the active span.
3. **Security headers and CORS.** Helmet (deny-all CSP, `X-Frame-Options: DENY`, `nosniff`,
   HSTS). CORS per surface: `/v1` allows no browser origin; `/dashboard/v1` and
   `/admin/v1` allow only `CORS_DASHBOARD_ORIGINS` and `CORS_ADMIN_ORIGINS`.
4. **Body parsing.** JSON only, 256 KB limit. Fastify's parser rejects prototype
   poisoning. Other content types get 415.
5. **Validation.** Global `ZodValidationPipe` (nestjs-zod). DTOs use strict schemas.
6. **Handler.** Thin controller.
7. **Envelope.** `ResponseEnvelopeInterceptor` wraps results as
   `{ success: true, data, meta: { requestId } }` unless the route is `@RawResponse()`
   (health, metrics).
8. **Serialization.** `@ApiEnvelopedResponses({ 200: schema })` turns one Zod schema into
   the Fastify response schema (fast-json-stringify, which also drops undeclared fields)
   and the OpenAPI response.
9. **Errors.** `GlobalExceptionFilter` maps everything through `error-mapper.ts` and the
   catalogue: `{ success: false, error: { code, message, details?, requestId, docUrl } }`.
   Client messages always come from the catalogue. 5xx responses never carry detail; the
   detail is logged with redaction.
10. **Completion.** One `request completed` log line (method, route template, status,
    duration) and the `core_http_request_duration_seconds` observation.

## Observability

- **Logs:** Pino JSON with gateway-compatible fields (numeric `level`, epoch `time`,
  `msg`). Every line passes through key-based redaction (`redaction.ts`, the gateway's
  approach): authorization, API keys, signatures, cookies, passwords, secrets, tokens,
  phone, msisdn, email, account numbers, PINs and card data, at any depth. Bodies are
  never logged.
- **Traces:** OpenTelemetry over OTLP/HTTP when `ENABLE_TELEMETRY=true`. HTTP in and out,
  undici (gateway calls carry `traceparent`), Postgres (no parameters), Redis (command
  name only), BullMQ via `bullmq-otel`. Probes are not traced.
- **Metrics:** `GET /metrics` with `Authorization: Bearer <METRICS_TOKEN>`, registered only
  when the token is set. Phase 0 metrics: `core_http_request_duration_seconds`,
  `core_db_pool_connections`, `core_queue_depth`, `core_queue_oldest_job_seconds`, and the
  default Node.js process metrics. Domain metrics arrive with their phases.

## Queues

`src/common/queue/queue.definitions.ts` lists the nine queues and concurrencies from
spec 8.9 under the Redis prefix `mulapay-core`. Default job options: 5 attempts,
exponential backoff from 1 s, completed jobs kept for 24 h (max 1000), failed jobs kept
for 7 days (max 10000). Queues with a specified schedule override these in their phase.

`WorkerHost` runs one BullMQ worker per registered processor. When a job fails its last
attempt (or throws `UnrecoverableError`) it is copied to the `dead-letter` queue under the
deterministic id `{queue}.{jobId}`, so a repeated failure event cannot create a second
entry. No worker consumes `dead-letter`; it is a parking lot for operations tooling.

The api process creates Queue handles only to read depth for metrics. Nothing enqueues
from a request handler; that path is the outbox (Phase 4).

## Phase 0 decisions to confirm

These choices were made where the spec is silent or ambiguous. Each is easy to change.

- **Health response bodies** match the gateway: `{ "status": "ok" }` and
  `{ "status": "ready" | "not_ready" }`, not the success envelope. Which check failed is
  logged, not returned.
- **Gateway readiness.** A gateway that is down makes core not-ready, as section 7.4
  lists. With `GATEWAY_BASE_URL` unset (allowed outside production) the check is skipped.
- **Docs paths** are `/docs/{public|dashboard|admin}/` and `.../openapi.json`. Docs are
  refused in production until authenticated docs exist.
- **Pool sizes.** `DB_POOL_MIN`/`DB_POOL_MAX` apply to each of the rw, ro and replica
  pools; the spec defines only one pair.
- **Replica fallback.** Without `DATABASE_REPLICA_URL`, replica reads use the rw pool and a
  warning is logged.
- **Head-based sampling.** "Errors always sampled" (section 10) cannot be done by an SDK
  head sampler; it needs tail-based sampling in the collector.
- **Worker and consumer metrics.** Those processes have no HTTP listener, so their own
  metrics are not scraped yet. Queue depth is reported by the api's `/metrics`.
- **Production-required secrets.** In production, boot fails without `TRUST_PROXY`, a
  Redis password, `GATEWAY_BASE_URL`, `GATEWAY_API_KEY`, the JWT key pair and `JWT_KID`,
  `DATA_ENCRYPTION_KEY` and `PII_HMAC_PEPPER`.
