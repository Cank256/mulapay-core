# Load results

Spec 9.1 targets are p99, steady state. `npm run test:load` (`test/load/api.load-spec.ts`) measures them and fails
when one is missed. Each run also writes `test/load/results/last-run.md` (not committed).

**Status: the harness is built and works. The targets are not verified, because this development machine could not
give a trustworthy measurement.** Treat every number below as a record of what happened on this machine, not as a
result against the targets.

## How it measures

- The application runs in the test process on a loopback port. The load comes from a separate Node process
  (`test/load/generator.mjs`, undici), so the two do not share an event loop. Postgres 16 and Redis 7 are Docker
  containers (Testcontainers) on the same machine.
- **Latency runs are open loop**: arrivals at a fixed rate (300 req/s for reads, 100 req/s for the payment write), 5 s
  warm-up, 15 s measured. Latency is counted from the moment a request was due, not from when a connection was free, so
  a slow server cannot hide its own queue.
- **Throughput run is closed loop**: 64 connections as fast as they go, over a mix of payment, balance and transaction
  reads.
- **In-process runs**: API key authentication (50,000 calls on a cached key), and a 6-line ledger entry (3,000 posted one
  after another to the same six accounts, then 8 callers each on their own accounts).
- Data: 200,000 transactions for the merchant under test and 300 payments created through the API, so the list and
  lookup queries do not run on empty tables.
- `POST /v1/payments` is measured without a gateway call, because the Provider Gateway client does not exist yet. The
  target excludes that call.

## What was measured on this machine

Host: Apple M1, 8 cores, 8 GiB, macOS, Node 24. When the runs finished, **11.5 GiB of the 12 GiB swap file was in use** and free
memory was about 64 MiB (checked after the later runs; run A was not checked at the time): three browsers and an editor were open, and Docker took 4 GiB. The same code gave p99 values
that differ by a factor of 100 between runs, and the API key check, which is pure CPU with no I/O, ranged from 0.49 ms to
6 ms. That spread is the machine, not the code.

p99 in ms unless stated. Run A was the first, B to 3 and the last column followed. A did not measure the balance or throughput routes (the test key lacked the scope; fixed since).

| Operation                                | Target  |     A |     B |     1 |      2 |     3 | no fsync wait |
| ---------------------------------------- | ------- | ----: | ----: | ----: | -----: | ----: | ------------: |
| API key authentication overhead          | < 1     | 0.487 | 0.953 | 6.071 |  2.658 | 5.540 |         1.799 |
| `GET /v1/payments/:ref`                  | < 50    |  47.7 | 285.4 | 283.4 | 5652.3 | 464.1 |         218.4 |
| `GET /v1/transactions` (25, cursor)      | < 120   |  11.5 | 341.2 |  83.3 | 5803.8 | 201.4 |         577.9 |
| `GET /v1/balances`                       | < 30    |     - |  74.8 | 411.7 |  438.0 |  65.9 |          43.4 |
| `POST /v1/payments` (no gateway call)    | < 80    | 282.7 | 13041 |  6687 |  27818 | 13044 |          4700 |
| `GET /dashboard/v1/analytics/overview`   | < 150   |  10.9 |  4450 | 639.2 |  10409 | 535.0 |         100.6 |
| Ledger posting, 6 lines, one caller      | < 25    |  55.2 |  58.4 |  73.2 |   25.1 |  36.2 |          30.5 |
| Read throughput, one API process (req/s) | > 1,200 |     - |   572 |   288 |    238 |   192 |           226 |

"No fsync wait" is `LOAD_ASYNC_COMMIT=1`, which sets `synchronous_commit = off` on the test database to see how much of
the write latency is the disk flush at commit. It is a diagnostic, not a result. It did not bring the write or the
ledger posting under target on this machine.

Other numbers from the same runs:

- Ledger posting with 8 callers, each on its own six accounts, p99: 105.7 ms (A), 127.4, 773.4, 133.6, 96.9 ms.
- Payment lifecycle (a stand-in for the event consumer, see below): 90 events/s (A), then 50, 18, 44, 40, 54.
- In run A, p50 for the same operations was small (payment read 4.0 ms, transaction list 3.4 ms, dashboard overview
  3.2 ms, payment create 12.2 ms, ledger posting 7.4 ms), so the median is inside the targets; the tail is what this
  machine cannot be trusted on.

## Not measured

- **Event consumer, more than 500 events/s.** The consumer is Phase 3 and is not built. The lifecycle service it will call
  was driven by 8 workers instead (figures above). That is an upper bound for the consumer, which also reads the gateway
  table and commits a cursor, and it is below 500 events/s on this machine in every run. Do not read it as a result.
- **Soak test** (30 minutes, no memory growth, no leaked connections). It belongs to Phase 9 (hardening) in the build order.

## What would make this a result

1. Run `npm run test:load` on a quiet machine with at least 16 GiB, or in CI, with Postgres on its own container limits
   (2 vCPU is the reference for the throughput target). Keep Docker's memory above 4 GiB.
2. Run it three times. Attach the three `last-run.md` files to this document and replace the table.
3. If `POST /v1/payments` or the ledger posting still miss their p99 on that hardware, profile before changing anything:
   a posting is one transaction with an idempotency row, the entry, 6 lines and 6 balance updates, and its p50 here was 7 ms.
   Do not relax a target or a financial rule to pass.

## Phase 9: soak, production topology and the audit chain

**No spec 9.1 latency or throughput target is verified, again.** The development machine (8 cores,
8 GiB) had 14.2 to 14.4 GiB of its 15 GiB swap in use and about 15 MB of free memory on every run, with
a browser and an editor holding most of the rest. The same soak, same code, same rates gave read p99
of 89 ms, 5.3 s and 220 s on three runs. Numbers from this machine are not evidence for or against a
target, and none is claimed. What the runs do establish is structural, and holds on any machine.

### What was built

- `test/load/soak.load-spec.ts` (`npm run build && npm run test:soak`): the **built** application runs as
  two operating-system processes, an API and a worker with its own pools and event loop, against Postgres
  and Redis containers, as in production. Three request streams run for `SOAK_MINUTES` (default 30): reads
  (payment retrieval, balances, transaction list), new live payments, and the same payments sent again
  under a fixed set of 25 `Idempotency-Key`s. A sampler (`test/load/sampler.ts`) records every 15 s, per
  process: memory, CPU, file descriptors; database connections, active, idle-in-transaction, lock waits,
  longest transaction, deadlocks, cache hit ratio, temp files; Redis memory, keys, clients, operations per
  second, evictions; every queue's waiting, active, delayed and failed jobs; container CPU and memory.
  Judged on the slope of the second half of the run, so warm-up is not a leak.
- `test/load/generator.mjs` gained `keyPool` (replayed idempotency keys), `windowMs` (latency per window) and
  a count of `Idempotency-Replayed` answers.
- `test/load/audit-chain.load-spec.ts`: how much write throughput the audit hash chain permits.

Not covered by the harness, and why: **gateway callbacks and the event consumer** (Phase 3 is not built;
payment events were driven through `PaymentLifecycleService.apply`, see the chaos suite), **merchant
payouts** (Phase 4 is not built; settlement payouts were exercised in the chaos suite against a fake
gateway), and **webhook delivery throughput** (delivery is exercised for correctness under duplicates and
Redis loss, not for rate).

### Soak results

Only a 3-minute smoke run was possible here. **The 30-minute soak required by spec 12 was not run**, because
on this machine a longer run would only have lengthened a collapse. A smoke run proves the harness and the
invariants; it cannot show a leak, which needs the second half of a long run.

Passing smoke run (3 minutes; 80 reads, 20 new payments and 10 retried payments per second offered):

| Property                                                    | Result                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Failed requests (reads 14,400; writes 3,600; retries 1,800) | 0; every read 200, every write 201                                                                                             |
| Idempotent retries replayed from the stored response        | 1,800 of 1,800, no second payment                                                                                              |
| Failed or stuck queue jobs after a 20 s drain               | 0 failed, 0 waiting                                                                                                            |
| Deadlocks                                                   | 0                                                                                                                              |
| Database connections                                        | peak 30 of 400 (about 7%); first 19, last 12                                                                                   |
| Database cache hit ratio                                    | 99.97%                                                                                                                         |
| Redis keys                                                  | grew 59 to 3,943, **all of the growth is `idem:*` markers with an expiry**; queue keys are fixed; none unbounded; no evictions |
| Process memory (API, worker)                                | 25 to 204 MB peak, ended at 91 MB; 73 to 87 MB, ended at 44 MB. A 3-minute window cannot show a leak                           |
| Ledger invariants after the run                             | all hold (`test/support/invariants.ts`)                                                                                        |

Two defects surfaced only because the soak ran the real topology, and are listed in
`PRODUCTION_READINESS.md`: a worker with no gateway configured fails the scheduled gateway-gap
reconciliation run (correct, and fail-safe: it refuses to read "no operations" as "no gap"), and an
exhausted connection pool answers `500`, not `503` with `Retry-After` (PERF-3).

### The audit chain is the throughput ceiling (PERF-2)

Under the soak, **76.7% of all database time was waiting on one row**, `audit_chain_head ... FOR UPDATE`
(3,772 calls, mean 222 ms, worst 14.6 s). Every audited write, which is every state-changing request, takes that
row lock and holds it until its transaction commits. `audit-chain.load-spec.ts` isolates it, so it is a
property of the design and not of the machine's load:

| Trailing work in the transaction after the audit row | Workers | Audited writes per second (two runs)         |
| ---------------------------------------------------- | ------- | -------------------------------------------- |
| 5 ms                                                 | 8       | 99 and 91                                    |
| 5 ms                                                 | 32      | 87 and 85 (more workers, no more throughput) |
| 20 ms                                                | 8       | 36 and 30                                    |

The ceiling is about `1 / (trailing work + commit time)` for the entire platform. The documented rule
("write the audit row last") keeps trailing work small, which is why the shipped paths are not worse. The
spec 9.1 targets (`POST /v1/payments` under 80 ms excluding the gateway, a 6-line posting under 25 ms) are not
reachable at the same time as a high write rate unless this changes. This needs an architecture decision;
see `SECURITY.md` PERF-2.

### To turn this into a result

1. A quiet machine, or CI, with at least 16 GiB and Docker given 4 GiB; 2 vCPU for the API as in spec 9.1.
2. `npm run build`, then `SOAK_MINUTES=30 npm run test:soak` three times, and `npm run test:load` three times;
   keep each `test/load/results/*.json`.
3. Judge latency only from runs where swap is idle. Do not relax a target or a financial control to pass.
