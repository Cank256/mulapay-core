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
