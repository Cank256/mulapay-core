# Production readiness (Phase 9)

Date of review: 2026-11-17. Reviewer: the Phase 9 hardening pass (an engineering agent; no human
sign-off has been given or implied). Specification: `CORE_API_BUILD_PROMPT.md` sections 9, 10, 11, 14.

## Decision

**NOT READY FOR PRODUCTION. Do not take live money.**

The rule for this phase is that every critical and high finding must be resolved or explicitly
approved through the project's documented risk process. Two things stop that from being met:

1. **Two phases of the specification are not built.** Phase 3 (the gateway event consumer, the
   `gateway_events` table, the cursor, the 18 handlers) and Phase 4 (collections through the gateway,
   merchant payouts, refunds, the fee engine, the chase job) do not exist. `AGENTS.md` records that these
   were deferred; the brief for this phase said the application was feature-complete, which is not so.
   Without the consumer, nothing moves a live payment out of `processing` except the sandbox, so Core cannot
   yet take a real payment end to end. Building them was out of scope ("do not add new business
   functionality") and would be a decision for the owner.
2. **Four high-severity findings are open**, and **the project has no documented risk-acceptance process**
   (only "decisions to confirm" lists with no approver or record), so none can be "approved" today. They need
   fixing, or a risk process and a named approver.

What is solid: the ledger, its database-enforced invariants, idempotency, the state machine, backup and
restore, crash safety under a killed database, graceful shutdown, the container image, the dependency
supply chain, and the observability of everything that exists. Details follow.

## Findings that must be resolved or approved before launch

| ID     | Sev     | Finding                                                                                                                                                                                                                                                                          | Needs                                                                     |
| ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| P3-P4  | Blocker | Gateway consumer, `gateway_events`, collections, payouts, refunds, fee engine and chase job are not built. Chaos tests A and G (consumer killed, crash before cursor commit), the 18 handlers, consumer throughput (> 500 events/s) and consumer lag alerts cannot be tested.    | Build Phases 3 and 4, then re-run `npm run test:chaos` and the load suite |
| DB-1   | High    | The application role owns the schema and tables, so stolen database credentials can disable the append-only triggers and rewrite the ledger and audit log. Proven by three `it.fails` tests.                                                                                     | Architecture decision: separate owner and migrator role (changes spec D2) |
| ENC-1  | High    | No KMS; one raw encryption key; no keyring; a key change or compromise makes every encrypted column unreadable; no re-encryption job.                                                                                                                                            | Architecture decision and build                                           |
| PERF-2 | High    | The single audit hash chain serialises every audited write: about 90 writes/s platform-wide with 5 ms of work after the audit row, about 30/s with 20 ms; 76.7% of database time under the soak was waiting for it. The spec 9.1 targets cannot all be met at a real write rate. | Architecture decision (sharded chain or post-commit sequencer)            |
| LOAD   | High    | **No spec 9.1 latency or throughput target has been verified**, and the 30-minute soak required by spec 12 has not been run. The only machine available was in swap collapse (see below).                                                                                        | Run on quiet hardware or CI, three times                                  |

Findings that do not block alone but should be fixed before launch: GW-1 (circuit breaker has no caller,
Phase 4), PERF-1 (no load shedding), PERF-3 (overload answers 500, not 503 with Retry-After), RDY-1 (no
health probe for the worker and consumer), GW-2 and GW-3, OBS-1 (six metrics missing, three belong to Phase 3),
and the unexercised point-in-time recovery. All are in `SECURITY.md`.

## Fixed in this phase

| ID     | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Proof                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-2   | **A database connection that died in use crashed the whole process** (uncaught exception, and the process exits on one): a failover would have taken down every API and worker pod at once. Found by the chaos suite.                                                                                                                                                                                                                                                          | `pool-resilience.int-spec.ts` failed with uncaught `Connection terminated unexpectedly` before the fix and passes after                                                                            |
| DB-3   | **A query on a database connection that goes silent waited forever** (no client-side timeout; the server's `statement_timeout` cannot fire if the server is unreachable). A network partition or a vanished database host would have left requests and pool clients hanging for the operating system's TCP timeout, which is hours.                                                                                                                                            | `pool-resilience.int-spec.ts` (a TCP proxy that goes silent): waited without end before, fails the query within the statement timeout plus 2 s after; pool closes                                  |
| DB-4   | **A pool connection leaked whenever `BEGIN` failed.** drizzle-orm 0.45.4 runs `begin` outside its `try/finally`, so a connection that looked healthy at checkout and failed on its first statement was never released: one slot of the pool lost per failure, for ever, and `app.close()` waiting on it (10 minutes in the chaos suite). Every write in the platform goes through `UnitOfWork`. Found only because the chaos suite killed the database during concurrent work. | `pool-resilience.int-spec.ts` reset-peer test: 1 client left checked out before, 0 after; `postgres.chaos-spec.ts` now closes cleanly. `UnitOfWork` owns checkout and release (`runInTransaction`) |
| OPS-1  | The migration job demanded the JWT private key, data-encryption key, PII pepper and gateway key to run SQL.                                                                                                                                                                                                                                                                                                                                                                    | `migrate-config.spec.ts`; the built image migrates 11 migrations with only `DATABASE_DIRECT_URL`, read-only                                                                                        |
| REL-1  | Nothing created partitions after the migration month plus three; after that rows silently fell into the default partitions, and a default partition holding rows blocks creating its month. No retention existed for request logs, deliveries, idempotency keys or published outbox rows.                                                                                                                                                                                      | Migration 0009, `lifecycle` module, 16 + 5 tests                                                                                                                                                   |
| QRY-1  | Stuck-transaction scans (gateway gap run, incident monitor, stuck list) had no index: 13, 47, 41 ms at 600k rows and growing with the table.                                                                                                                                                                                                                                                                                                                                   | Migration 0010; 0.7, 0.16, 0.13 ms; `query-plans/phase9.txt`                                                                                                                                       |
| OBS-2  | `core_ledger_posting_duration_seconds` was missing; partition health had no signal.                                                                                                                                                                                                                                                                                                                                                                                            | metrics added; test in `ledger-posting.int-spec.ts`                                                                                                                                                |
| TEST-1 | The circuit breaker had no tests.                                                                                                                                                                                                                                                                                                                                                                                                                                              | `circuit-breaker.spec.ts` (7), Redis behaviour in `gateway-failure.int-spec.ts`                                                                                                                    |

One thing I believed was a defect and was not: graceful shutdown (`createHttpApp` already enables the hooks; I had
only read `main.api.ts`; the test I wrote passed against the unfixed code, so I removed my redundant edit and kept the
test). One diagnosis I got wrong and corrected: I first attributed the shutdown hang after a database crash to my own
test's stalled transaction; bisecting the suite, then inspecting the pool, showed an application connection leak (DB-4),
which is why the first two explanations are not in this document.

## Functional readiness

| Area                                                                          | Status                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Identity, merchants, MFA, step-up                                             | Built, tested (Phases 1)                                                            |
| Ledger, balances, holds                                                       | Built; 100% line, branch, function coverage; invariants in the database             |
| Payments, links, sessions, idempotency                                        | Built without the gateway; terminal states only reachable by events and the sandbox |
| Developer platform, webhooks, signing                                         | Built; webhook delivery at least once, verified under duplication and Redis loss    |
| Settlement, reconciliation                                                    | Built; settlement payout is the only real gateway call                              |
| Compliance, support, operations                                               | Built (Phases 7 and 8)                                                              |
| **Gateway consumer, collections, merchant payouts, refunds, fees, chase job** | **Not built**                                                                       |

## Financial integrity

Independent invariant checks (`test/support/invariants.ts`, 14 queries written separately from the application's
own integrity service) pass after every chaos test and on the restored backup: every entry balances, one
currency per entry, at least two lines, `account_balances` equals the sum of lines, no merchant payable in a debit
position, no negative available balance, one ledger effect per business event, a payment entry exists only for a
succeeded payment and exactly once for each, nothing posted for an unpaid settlement batch and every paid batch
has entries, holds end in one state, terminal transactions have a completion time, the audit sequence has no gaps.
The trial balance balances per environment and currency.

| Test                                                       | Result                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| PostgreSQL SIGKILL during 48 concurrent event applications | no event lost or doubled; no half-applied state; pools reconnect               |
| Connection killed before COMMIT                            | rolled back entirely; redelivery applies once                                  |
| Commit with a lost acknowledgement                         | redelivery is `duplicate`                                                      |
| 20 simultaneous duplicate events                           | 1 applied, 19 duplicate, 1 entry                                               |
| Settlement payout through a 60 s gateway 504               | unknown stays unknown; no posting; 1 gateway request; settles once on recovery |
| `idempotent` HTTP retries, 1,800 over 25 keys              | all replayed, none duplicated                                                  |

Not tested because the code does not exist: refund and payout postings, merchant payout holds, the consumer.
Not verified for hardware reasons: the nightly ledger recomputation at volume.

## Security findings

See `SECURITY.md`, "Phase 9 review". Summary: 2 high and open (DB-1, ENC-1), 1 high open on throughput (PERF-2),
3 high fixed (DB-2, DB-3, DB-4), 1 medium fixed (OPS-1), and the medium and low items listed above. What was verified to hold:
database roles and grants (45 assertions), append-only controls against the application role, no Core write to a
gateway table, webhook SSRF controls, request signing and replay protection failing closed, admin MFA and
step-up, secrets absent from the image, security headers and no `Server` header, production configuration
refusing unsafe settings. Not performed: a penetration test, a review of the full Section 11 PII storage
(the customer module's encrypted columns), and an automated scan of log output for PII across all flows.

## Load-test results

See `LOAD_RESULTS.md`. **No 9.1 target verified.** The machine had 14.2 to 14.4 of 15 GiB swap in use throughout;
identical runs differed 60-fold. Structural results that hold anywhere: zero failed requests and all 1,800
idempotent retries replayed in the 3-minute smoke run; no deadlocks; database connections at 7% of the maximum;
99.97% cache hit; Redis growth bounded (all of it expiring idempotency markers); no stuck or failed jobs after
drain. Not run: a 30-minute soak, gateway callbacks and consumer throughput (no consumer), merchant payouts (no such
product), webhook delivery rate.

## Soak-test results

**Not run to completion.** A 3-minute smoke run passed. A leak needs the second half of a long run, and the
harness is built, reviewed and ready (`npm run build && SOAK_MINUTES=30 npm run test:soak`). Until it has run on
suitable hardware, memory leaks, connection leaks and latency drift are unknown, not absent.

## Chaos-test results

`npm run test:chaos` (own containers, fixed ports, kill with SIGKILL).

| Scenario (task list)                            | Result                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Kill the gateway consumer during a batch     | **Not run: no consumer**                                                                                                                          |
| B. Kill PostgreSQL during processing            | Pass. Found and fixed DB-2                                                                                                                        |
| C. Gateway returns 504 for one minute           | Pass (settlement payout, the one live gateway call)                                                                                               |
| D. Restart workers during queue processing      | Pass. SIGKILLed worker: 12 jobs, 4 in flight; all completed 68 s later, each effect once, none failed. 30 s lock plus 30 s stall check by default |
| E. Duplicate gateway events                     | Pass (driven through the same service the consumer will call)                                                                                     |
| F. Duplicate webhook jobs                       | Pass: 8 workers on one delivery sent one request; 5 on a failing one made one attempt                                                             |
| G. Interrupt between applying and acknowledging | Pass at transaction level (rolled back, or duplicate on redelivery). The cursor commit part **cannot be tested**                                  |
| Redis lost with its data                        | Pass: outbox and deliveries rebuilt from Postgres, delivered once. With Redis down, reads served, writes refused 503                              |
| Backup restored onto a new server               | Pass                                                                                                                                              |
| Graceful shutdown of the built API and worker   | Pass                                                                                                                                              |

Incident generation was verified for the stuck transaction only (`ops:stuck_transactions` opens when a payout
is unknown for longer than the threshold). Not verified: an incident for a ledger integrity failure under chaos
(none occurred, correctly), queue depth, or consumer lag (no consumer).

## Database findings

Partitioning and retention built and tested (above). 11 migrations apply in the production image, in one
transaction, as the application role, to a database that already holds data, twice with no effect. Plans for 36 explained
statements (about 25 distinct queries, several before and after an index), committed. One index added with evidence, one measured and declined. `audit_chain_head` is the
bottleneck (PERF-2). Role and grant review: DB-1. No row-level security (not required by the spec). Not done:
`VACUUM` and bloat behaviour over days, replica lag, PgBouncer transaction-mode behaviour (the pool settings are
correct for it by inspection, no PgBouncer was in the test), `pg_stat_statements` on a production-sized dataset.

## Dependency findings

Production: **0 vulnerabilities** (245 packages). Development tooling: 29 moderate and 2 low, none ships; the
automatic "fixes" are downgrades and were not applied. Licences: all permissive, none copyleft or unknown.
Lockfile: every entry has a sha512 integrity hash from the npm registry. Major upgrades available (NestJS 12,
BullMQ 6, ioredis 6, undici 8, others) are not security-driven and need their own change with the full suite. The
image scan (Trivy) runs in CI and was not run here. No dependency was upgraded in this phase, so no regression
run was owed.

## Observability

Present and verified: structured logs with request ids, redaction by key (all names in spec 10), metrics,
queue depth and age, pool, partitions, ledger posting duration, reconciliation, incidents. Missing: `core_payment_initiations_total`,
`core_ledger_entries_total` (deliberately not added from inside a transaction, where it would count entries that
later roll back; add it after commit), `core_merchant_available_balance_minor`, and the three gateway metrics that
need the consumer. Gateway latency and error rate, and reconciliation lag for the consumer, cannot exist yet.
Traces were not examined. Redaction is by key name, so a secret inside free text is not scrubbed.

## Production-readiness checklist

| Item                        | Status                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Docker image                | Verified: non-root, no shell, read-only filesystem, dev dependencies absent, 412 MB                                        |
| Environment validation      | Verified in the image                                                                                                      |
| Migrations                  | Verified; migration job needs only the database URL                                                                        |
| Startup and shutdown        | Verified for API and worker                                                                                                |
| Health, readiness, liveness | API yes; **worker and consumer none (RDY-1)**; no image `HEALTHCHECK`                                                      |
| Resource limits             | Starting points in `DEPLOYMENT.md`; not measured                                                                           |
| Connection pools            | Fixed (DB-2); sizing guidance in `DEPLOYMENT.md`                                                                           |
| Timeouts, retries           | Gateway one attempt plus same-key retry; statement and idle timeouts as role defaults; `GATEWAY_MAX_RETRIES` unused (GW-3) |
| Circuit breakers            | Built and tested; **not wired** (GW-1)                                                                                     |
| Backup, restore             | Logical restore verified; PITR not exercised                                                                               |
| Deployment order, rollback  | Documented in `DEPLOYMENT.md`; not rehearsed on staging                                                                    |
| `gateway:verify` script     | Listed in spec 13; does not exist                                                                                          |

## What would make this ready

1. Build Phases 3 and 4, then re-run the chaos suite (A and G become possible) and the consumer tests.
2. Decide and implement DB-1, ENC-1 and PERF-2, or adopt a written risk process with a named approver and record
   an explicit acceptance for each, with an expiry date.
3. Run `SOAK_MINUTES=30 npm run test:soak` and `npm run test:load`, three times each, on hardware with free memory
   (16 GiB, 2 vCPU for the API), and keep the result files.
4. Rehearse deploy, rollback and point-in-time recovery on staging.
5. Close PERF-1, PERF-3, RDY-1, GW-1 to GW-3 and OBS-1.
6. Have a person who did not write this review read it, and sign.
