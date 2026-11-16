# Reconciliation and settlement

Spec sections 6.8 and 6.9. Built in Phase 6 on top of the ledger of Phase 2 and the payment
domain; the gateway calls go through an explicit port (see
[GATEWAY_INTEGRATION.md](GATEWAY_INTEGRATION.md)). Decisions that need your confirmation are in
[ARCHITECTURE.md](ARCHITECTURE.md) ("Phase 6 decisions to confirm").

## The rule that governs everything here

A reconciliation run **never changes financial state**. It records what it checked and raises
exceptions for a person. Only a resolution does anything, and a resolution that moves money
(a reversing entry, a write-off) needs a second person to approve it.

## The four runs

Each run is a row in `reconciliation_runs`. A run is keyed by the window it covers (`run_key`), and
by what it looks at (`scope_key`):

- **The same window is the same run.** Asking for it again returns the first run and raises
  nothing twice. A scheduled run is keyed by its time bucket (gap: `RECON_GAP_INTERVAL_SECONDS`,
  integrity: the hour, balance proof: the UTC day). A manual run is keyed by the caller's
  `idempotencyKey`. A statement run is keyed by the statement.
- **One run of a kind and scope at a time.** A partial unique index allows one `running` row per
  `(kind, scope_key)`. A second request answers `in_progress`. A worker that dies leaves a
  `running` row whose lease (`RECON_RUN_LEASE_SECONDS`) expires; the next request marks it
  `failed` (`lease_expired`) and takes the slot.
- **A failed run is retried under the same key** (`attempts` + 1). A check that throws leaves the
  run `failed` with the error name. It never leaves a half-counted `completed`.
- **The same discrepancy seen again is one exception.** `reconciliation_exceptions.dedupe_key` is
  unique while the exception is open or investigating; a later run counts another occurrence.

| Run                  | When                               | Looks at                                                                                                                                                     | Raises                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway_gap`        | every `RECON_GAP_INTERVAL_SECONDS` | `processing` transactions older than `RECON_STALE_MINUTES`, each looked up at the gateway by external id; and gateway operations core has no transaction for | `stale_processing_transaction`, `gateway_state_differs`, `gateway_amount_mismatch`, `core_transaction_missing_at_gateway`, `gateway_operation_missing_in_core`                                                              |
| `ledger_integrity`   | hourly                             | unbalanced entries, `account_balances` against the journal, merchant payable in a debit position, negative available balance, suspense, totals               | `ledger_unbalanced_entry`, `ledger_balance_mismatch`, `ledger_negative_merchant_payable`, `ledger_negative_available_balance`, `ledger_suspense_nonzero`, `ledger_totals_unbalanced`. Any finding opens a **sev1 incident** |
| `provider_statement` | when a statement is uploaded       | statement rows against core transactions                                                                                                                     | `statement_unmatched_row`, `statement_amount_mismatch`, `statement_duplicate_row`, `statement_unmatched_core_transaction`                                                                                                   |
| `balance_proof`      | daily, 02:00 UTC                   | provider accounts against the gateway; merchant payable against merchant balances; reserve account against reserve entries                                   | `balance_provider_mismatch`, `balance_provider_unavailable`, `balance_merchant_mismatch`, `reserve_mismatch`                                                                                                                |

A gateway that cannot be asked is never a pass. In the gap run, a failed lookup is a
`stale_processing_transaction` exception; a failed operation list fails the run (half a comparison is
not a result). In the balance proof it is `balance_provider_unavailable`.

### Gateway gap

Looks only at the `live` environment (test keys never reach the gateway). A stale transaction is
compared with what the gateway says; the answer is recorded in the exception and **core's
transaction is not touched**, even when the gateway says `successful`. Applying an outcome is the
event consumer's job, or an explicit status check (spec 17.5). The list of gateway operations is
read newest first, back 24 hours; an operation older than a minute whose `externalId` core does not
know is a `gateway_operation_missing_in_core`: a lost record, severity critical.

### Ledger integrity

Uses `LedgerIntegrityService` (Phase 2) unchanged, scoped by environment and optionally currency.
The scheduled run covers `live`. **Any finding opens a sev1 incident** (`incidents`), deduplicated per
scope while it is unresolved: a standing failure is one incident whose `detection_count` grows, not
one per hour. The metrics `core_ledger_integrity_failures{kind}` and `core_suspense_balance_minor`
are set by the run.

### Provider statements

`POST /admin/v1/reconciliation/statements` stores the statement and every row in one transaction,
with an outbox message that queues the match. The same statement (same content hash for the
provider and currency) is refused with 409. Matching, in this order:

1. by provider reference (`provider_transaction_id`); same reference with another amount or
   currency is a **mismatch**, not a match;
2. for rows still unmatched, by amount, currency and the date window
   (`RECON_STATEMENT_DATE_WINDOW_HOURS`), the closest transaction that has no provider reference
   of its own;
3. a reference repeated inside the statement, or matched by an earlier statement, is a
   **duplicate** and matches nothing;
4. a transaction that completed inside the statement's period and matched no row is
   `statement_unmatched_core_transaction`.

Rows go in the request body (at most 2,000). The presigned upload of the spec needs object storage,
which is not built.

### Balance proof

For each provider and currency in the ledger: `1000:provider_clearing:{provider}` against the
gateway's **collection** balance, `1010:provider_float:{provider}` against its **disbursement**
balance, each within `RECON_BALANCE_TOLERANCE_MINOR` (default 0). The sum is reported too. Each
merchant's payable, **recomputed from the journal lines**, against what the balances service
reports. Each merchant's reserve account against its unreleased `reserve_entries`.

## The exception queue

`GET /admin/v1/reconciliation/exceptions` lists newest first. Statuses: `open`, `investigating`,
`resolved`, `written_off`. A resolved or written-off exception never changes again (database guard).
Every step writes an audit row and a queue note (`reconciliation_exception_notes`, append-only).

| Step    | Route                              | Effect                                                           |
| ------- | ---------------------------------- | ---------------------------------------------------------------- |
| assign  | `POST .../exceptions/:ref/assign`  | owner set, status `investigating`                                |
| note    | `POST .../exceptions/:ref/notes`   | investigation note                                               |
| resolve | `POST .../exceptions/:ref/resolve` | `matched_manually` resolves at once; the others create a request |
| decide  | `POST .../resolutions/:ref/decide` | a different staff member approves or rejects the request         |

Resolutions:

- **`matched_manually`**: a person checked and the records agree. No money moves.
- **`corrected_with_reversal`**: reverses a posted live entry with `ReversalService`. A reversal
  cannot be reversed.
- **`written_off`**: debit `5100:loss_writeoff`, credit the account holding the unexplained amount.
  Only platform asset accounts qualify (provider clearing, provider float, bank, suspense); a merchant
  payable or reserve is refused. The amount may not exceed the exception's own amount.

Approval posts the entry in the same transaction that records the decision, so either the exception
is resolved and the entry exists, or neither. Rejecting leaves the exception `investigating`. The
approver is never the requester: checked in the service and by a database CHECK. One request may
be pending per exception.

### Write-off procedure

1. Confirm the discrepancy is real and cannot be matched or corrected (notes on the exception).
2. `resolve` with `written_off`, naming the account that holds the amount and the amount. Needs
   `reconciliation:work` and a recent step-up.
3. A different super admin reviews `GET .../pending-resolutions` and decides. Needs
   `reconciliation:approve` and a recent step-up.
4. The entry (`reconciliation.writeoff`, `source_id = writeoff:{request ref}`) is on the exception as
   `resolutionEntry`.

## Reporting

`GET .../status` (newest run per kind, open exceptions by kind and severity, oldest age, pending
approvals), `.../runs`, `.../unresolved`, `.../history` (resolved and written off), and the metric
`core_reconciliation_exceptions_open{kind,severity}`, refreshed on every scrape.

## Settlement

### Cycle and period

A cycle has a cron `schedule`, `currency`, `delay_days`, `cutoff_time` and `timezone`
(`/admin/v1/settlement/cycles`). A run at instant `asOf` settles payments completed before the **period
end**: the latest cutoff at or before `asOf`, minus `delay_days` calendar days (same wall-clock time, so
a daylight-saving change moves the instant, not the local time). A merchant's period starts where its
latest live batch ended, or at the beginning of time, so periods never overlap and never leave a gap.
A run waits until the period end is `COMMIT_SAFETY_MS` (60 s) behind `asOf`, so a payment whose
transaction was still committing is not missed.

The worker's `settlement.tick` job runs every minute: for each active cycle it finds the latest cron
occurrence, runs the cycle as of that occurrence, then sweeps releasing batches.

### Payable

```
payable = gross successful payments - refunds - fees - rolling reserve
          - dispute holds - AML holds  (+ earlier reserve released into this batch)
```

All `bigint` minor units. The reserve is `floor(gross * percent_bps / 10_000)`. Two limits keep the
batch honest against the ledger: the reserve and the draw from the payable account never exceed what is
available there (payable less holds), and a negative flow pays nothing. What the account could not
cover is `shortfall_minor`. A batch below the cycle's `min_payout_minor` is not created: its payments
stay unsettled and are included in the next period (the run reports it as rolled over). The database
refuses a batch below its own minimum.

Dispute and AML holds are active holds whose reason starts `dispute:` or `aml:` (Phase 7 places them).

### Batch states

```
draft -> pending_approval -> approved -> releasing -> paid
                                     \-> failed   (from releasing)
draft | pending_approval | approved -> cancelled
```

**Nothing posts to the ledger at `draft`, `pending_approval` or `approved`.** The submitter cannot
approve (service and database). `approve` and `release` need a recent step-up. Approval refuses if
the merchant's destination changed since submission (fingerprint).

### Release

1. `release` (one transaction): validates the merchant and destination, creates the payout as a
   `settlement` transaction with its gateway `externalId` (`po_` + ULID), places a hold on the payable
   account for what will leave it, moves the batch to `releasing`, writes an outbox message. A second
   call returns the same batch.
2. `settlement.submit-payout` (a job after commit): sends the disbursement with that same key.
3. The outcome arrives from the gateway event consumer or from `verifyPayout`, and
   `SettlementOutcomeService` applies it:

| Gateway outcome                  | Payout / batch                                  | Hold     | Ledger                                    |
| -------------------------------- | ----------------------------------------------- | -------- | ----------------------------------------- |
| accepted, `pending`              | `processing`                                    | active   | nothing                                   |
| 504, timeout, 5xx, `unknown`     | `processing` + `outcome_unknown`                | active   | nothing; waits for the gateway or a check |
| `successful`                     | `succeeded` / `paid`                            | captured | settlement entries (below)                |
| `failed`, `expired`, `cancelled` | `failed` / `failed`                             | released | nothing                                   |
| 400, 409 on submit               | `failed` / `failed` (a core bug)                | released | nothing                                   |
| 401, 403, 404, 429 on submit     | unchanged; the job is retried with the same key | active   | nothing                                   |

A success after the batch failed, a failure after it was paid, or a different amount is **refused**
and raised as an exception (`late_conflicting_event`, `gateway_amount_mismatch`): money may have moved
at the provider while the ledger says it did not. A repeated event key is recorded once.

### Ledger entries of a paid settlement

```
released:   DR 2000:merchant_payable  P + V     (P drawn from payable, V reserve withheld)
            DR/CR 2010:merchant_reserve |R - V|  (R earlier reserve released; one net line)
            CR 1200:settlement_in_transit  N      (N = P + R)
confirmed:  DR 1200:settlement_in_transit  N
            CR 1010:provider_float:{provider}  N
```

Keys `sha256('settlement:{batch ref}:release')` and `...:confirm`. The confirmation credits the
provider float, not `1100:bank` as spec 5.5 writes; see the decisions to confirm.

### Rolling reserve

`rolling_reserves` per merchant and currency (`percent_bps`, `hold_days`); no row means the platform
defaults `ROLLING_RESERVE_BPS` and `ROLLING_RESERVE_HOLD_DAYS`. A paid batch creates a
`reserve_entries` row for what it withheld, due after `hold_days`. A draft batch **claims** the due
entries (`release_batch_id`), so no other batch can take them; paying marks them released, cancelling
or failing gives them back. `reserved` in the merchant balance stays 0: the settlement entry moves the
reserve out of the payable account, so subtracting it again would count it twice.

### Reports

`GET /admin/v1/settlement/batches/:ref/statement` (staff) and `GET /dashboard/v1/settlements/:ref/statement`
(merchant) return the itemised statement: totals, every payment, refund and reserve line, the payout
reference, a masked destination, the status history, and the reconciliation references (statement rows
that matched the payout; for staff also the ledger entries and open exceptions). `.../statement/csv`
returns the same as CSV text; every cell is quoted and formula-looking text is neutralised.
