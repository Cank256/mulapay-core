# Deployment

How to take Core API from an image to a running, safe production system, and how to undo it.
Companion pages: `OPERATIONS.md` (runbooks, disaster recovery), `DATABASE.md` (roles, migrations),
`SECURITY.md` (controls), `PRODUCTION_READINESS.md` (what is and is not ready).

## What is deployed

One image, three processes, chosen by `APP_ROLE` (spec 4.1).

| Role       | Entry          | Replicas  | Listens | Notes                                                                  |
| ---------- | -------------- | --------- | ------- | ---------------------------------------------------------------------- |
| `api`      | `dist/main.js` | 2 or more | 4000    | stateless; scale horizontally; behind the edge proxy                   |
| `worker`   | `dist/main.js` | 2 or more | none    | BullMQ processors and all schedules; safe to run several               |
| `consumer` | `dist/main.js` | exactly 1 | none    | holds a Postgres advisory lock and exits if it cannot; **idles today** |

The consumer applies gateway events (Phase 3). That code is not built (`PRODUCTION_READINESS.md`),
so the consumer process only holds its lock. Deploy it so the singleton and its alerts are in place,
but do not rely on it for payment outcomes.

## The image

`docker build --target runtime -t mulapay-core:<git-sha> .`

- Multi-stage; the runtime stage is `gcr.io/distroless/nodejs22-debian12:nonroot`: no shell, uid
  65532, production dependencies only (`npm ci --omit=dev --ignore-scripts`), the lockfile pinned.
- Run with a read-only root filesystem. The process writes only to stdout; nothing else needs a
  writable path (verified in this phase: the built image boots read-only, answers `/v1/health` and `/v1/health/ready`, and stops on SIGTERM in about a second with exit code 0).
- CI builds the image and fails on a HIGH or CRITICAL fixable CVE (Trivy), and fails `npm audit`
  at high for production dependencies.
- Tag with the git SHA. Never deploy `latest`.

## Environments

| Environment | Purpose                         | Notes                                                                |
| ----------- | ------------------------------- | -------------------------------------------------------------------- |
| development | `docker compose up`             | compose is for development only; credentials in it are throwaway     |
| staging     | production-shaped, sandbox keys | same image, same migrations, same `NODE_ENV=production` validation   |
| production  | live money                      | `NODE_ENV=production`; the process refuses to start on a weak config |

## Configuration

Every variable is validated at boot by `src/config/env.schema.ts`; the process exits with the list
of failing names (never values). With `NODE_ENV=production` the schema additionally refuses to boot
when any of these hold: `TRUST_PROXY` empty; `REDIS_URL` without a password;
`WEBHOOK_ALLOW_PRIVATE_NETWORKS=true`; `ENABLE_API_DOCS=true`; `OPS_FLAG_CHANGE_APPROVAL=never`; a
missing `GATEWAY_BASE_URL`, `GATEWAY_API_KEY`, `JWT_*`, `DATA_ENCRYPTION_KEY` or `PII_HMAC_PEPPER`;
`S3_BUCKET_DOCUMENTS` without `S3_SERVER_SIDE_ENCRYPTION`.

Two settings are optional in the schema but change behaviour, so check them for every environment:

- **Sanctions screening** works only when both `SANCTIONS_PROVIDER` and `SANCTIONS_API_KEY` are set. Without
  them every screening attempt fails with `ScreeningUnavailableError` (fail closed), so no subject is cleared by
  screening. The schema does not require them in production, so a missing pair shows up as failing screening
  jobs, not as a boot error. `SANCTIONS_PROVIDER=complyadvantage` is accepted by the schema but has no adapter.
- **A worker without `GATEWAY_BASE_URL`** shows a failed `reconciliation.gateway-gap` job every five minutes,
  because the gap run has no gateway to ask. Production refuses to boot without `GATEWAY_BASE_URL`, so this
  occurs only in development and staging. Set the variable, or expect and ignore that job there.

Secrets come from the secret manager, not from the image or the compose file.

| Area           | Setting                                                        | Production guidance                                                                                   |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Database pools | `DB_POOL_MAX` (default 20 per process)                         | sum over all processes must stay below PgBouncer's `default_pool_size` and Postgres `max_connections` |
| Timeouts       | `DB_STATEMENT_TIMEOUT_MS` 15000, `DB_IDLE_TX_TIMEOUT_MS` 10000 | also set as role defaults by the bootstrap SQL                                                        |
| Gateway        | `GATEWAY_TIMEOUT_MS` 30000                                     | must stay under the gateway's own provider timeouts                                                   |
| Rate limits    | `RATE_LIMIT_*`                                                 | defaults are the spec's; the edge adds a coarse limit                                                 |
| Logging        | `LOG_LEVEL=info`                                               | never `debug` in production: it widens what is logged                                                 |
| Metrics        | `METRICS_TOKEN` (24+ characters)                               | `/metrics` exists only when set; keep it off the public edge                                          |

## Order of a deployment

Schema changes are additive and backward compatible with the previous release (expand, then
contract in a later release), so the previous image keeps working against the new schema. That is
what makes rollback a redeploy and not a restore.

1. **Gateway first, if it changed.** Core reads `public.operation_events` and
   `public.provider_operations`; gateway migrations that touch them ship before Core. After they
   run, re-run `src/db/bootstrap/002_gateway_read_grants.sql` as a superuser.
2. **Bootstrap SQL once per environment** (DBA, superuser): `001_core_roles_and_schema.sql` creates
   the roles, the `core` schema and role defaults; it is idempotent. Not part of a release.
3. **Check large-table indexes** (next section) when the release adds one.
4. **Migrate**: a one-off job from the new image, as `mulapay_core_rw` over `DATABASE_DIRECT_URL`
   (not PgBouncer). It needs that one variable (and optionally `LOG_LEVEL`) and nothing else: no signing, encryption or provider secret goes to the job: `docker run --read-only ... mulapay-core:<sha> dist/db/migrate.js`. It takes an
   advisory lock, refuses an edited migration file, and applies every pending migration in one
   transaction: all or nothing. Stop here if it fails; nothing else has changed.
5. **Worker**, then **consumer**, then **api**, each as a rolling update. Workers first so every
   job and outbox handler the new API can produce already exists. The consumer is a singleton:
   stop the old one, start the new one (the lock guarantees they never overlap).
6. **Smoke test** (below).

## Large-table index procedure

A plain `CREATE INDEX` on a partitioned table takes a `SHARE` lock on every partition while it
builds: writes to `transactions` stop. That is instant on a small table and an outage on a large
one. Migration `0010_transactions_processing_index` uses `CREATE INDEX IF NOT EXISTS` so it can be
done ahead of time without blocking. For a table above about a million rows:

```sql
-- 1. the parent index, without building anything yet
CREATE INDEX transactions_processing_idx ON ONLY core.transactions (created_at) WHERE status = 'processing';
-- 2. per partition, without blocking writes (repeat for every partition, including the default)
CREATE INDEX CONCURRENTLY transactions_202611_processing_idx ON core.transactions_202611 (created_at) WHERE status = 'processing';
ALTER INDEX core.transactions_processing_idx ATTACH PARTITION core.transactions_202611_processing_idx;
```

`CONCURRENTLY` cannot run inside the migrator's transaction, which is why this is a manual step.
When every partition is attached the parent index becomes valid, and the migration is a no-op.

## Health, readiness and shutdown

| Probe                | Where                  | What it checks                                                                              |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| Liveness             | `GET /v1/health`       | the process answers; no dependency check, so a database outage does not restart every pod   |
| Readiness            | `GET /v1/health/ready` | rw database, ro database, Redis, gateway readiness                                          |
| `worker`, `consumer` | none                   | **no HTTP probe exists** (finding RDY-1). Use the queue-depth and consumer-heartbeat alerts |

Shutdown: Nest shutdown hooks are on for the API (in `createHttpApp`) and the worker; the consumer handles `SIGTERM` itself. On `SIGTERM` the API stops accepting
connections and finishes in-flight requests (verified by `test/chaos/shutdown.chaos-spec.ts` against the built artefact); a worker waits for its active jobs
(`worker.close()` has no timeout of its own). Set `terminationGracePeriodSeconds` to at least 60. A
job still running when the orchestrator sends `SIGKILL` is recovered by BullMQ's stalled-job check
(about a minute, measured in `PRODUCTION_READINESS.md`) and re-run; every job is idempotent. A
process that receives an uncaught exception or unhandled rejection logs fatal and exits non-zero.

## Resources

Starting points, to be replaced by measurements on production-like hardware (the development
machine could not give trustworthy figures, see `LOAD_RESULTS.md`):

| Process    | CPU request / limit | Memory request / limit | Notes                                                                            |
| ---------- | ------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `api`      | 1 / 2 vCPU          | 512 MiB / 1 GiB        | one Node process uses about one core; the spec's throughput target is per 2 vCPU |
| `worker`   | 1 / 2 vCPU          | 512 MiB / 1 GiB        | report generation streams; it should not need more                               |
| `consumer` | 0.25 / 1 vCPU       | 256 MiB / 512 MiB      |                                                                                  |

Add `--max-old-space-size` at about 75% of the memory limit so Node fails with a heap error, not an
OOM kill that gives no log line.

## Smoke test after a deployment

1. `GET /v1/health/ready` is 200 on every api pod.
2. `GET /metrics` (with the token): `core_db_pool_connections`, `core_queue_depth` present; no
   queue's `core_queue_oldest_job_seconds` growing.
3. `core_partition_months_ahead` is 2 or more for every table and `core_partition_default_has_rows`
   is 0 (`OPERATIONS.md`, partitions).
4. Create a sandbox payment with a `test` key and watch its webhook arrive.
5. `GET /admin/v1/ledger/integrity` reports no violations.
6. The audit chain verifies: `GET /admin/v1/audit-logs/verify`.

## Rollback

| What went wrong                         | Action                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| New image misbehaves, migration applied | redeploy the previous image, in the order api, consumer, worker. The schema is compatible                                         |
| Migration failed                        | nothing applied (one transaction). Fix and redeploy; the old image is still running                                               |
| Migration applied and is itself wrong   | **do not edit or reverse it.** Add a new corrective migration. Migrations are append-only and the migrator refuses an edited file |
| Data damaged                            | restore from backup to a new server (`OPERATIONS.md`, disaster recovery), never in place                                          |
| Bad config                              | the process refuses to boot; fix the variable and redeploy                                                                        |

There are no down migrations on purpose: a down migration on a financial schema is a second,
untested way to damage data.

## Backups

| Item           | Strategy                                                                                                                                                                                        | Restore tested                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PostgreSQL     | continuous WAL archiving for point-in-time recovery, plus a daily base backup; keep 35 days online. Financial records live in the database for 7 years; backups are for recovery, not retention | yes: `test/chaos/recovery.chaos-spec.ts` (`pg_dump` and roles onto a fresh server) |
| Redis          | AOF every second. Redis holds no financial truth; losing it loses queued jobs, which are rebuilt from Postgres                                                                                  | yes: Redis loss test                                                               |
| Object storage | bucket versioning and a lifecycle rule; report files expire after 7 days by design                                                                                                              | not tested                                                                         |
| Secrets        | the secret manager's own backup; the encryption data key is **unrecoverable if lost** and every encrypted column with it                                                                        | n/a                                                                                |

Point-in-time recovery with WAL archiving was not exercised in this phase: only a logical restore
was. Exercise it in staging before launch.
