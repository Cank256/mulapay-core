# Query plans

Committed `EXPLAIN (ANALYZE, BUFFERS)` output for every hot query (spec 9.2 rule 7 and
section 16). Each phase adds a `phaseN.sql` script and its `phaseN.txt` output.

A script seeds synthetic rows inside a transaction, runs `ANALYZE`, explains each query,
and rolls back, so it can run against any freshly migrated database:

```bash
psql "postgres://mulapay_core_rw:...@localhost:5433/mulapay" -f docs/query-plans/phase1.sql > docs/query-plans/phase1.txt
```

## Phase 1 ([phase1.sql](phase1.sql), [phase1.txt](phase1.txt))

| Query                                     | Index used                                                        |
| ----------------------------------------- | ----------------------------------------------------------------- |
| API key authentication by `key_id`        | `api_keys_key_id_key`, then `merchants_pkey`                      |
| Dashboard principal resolution (per call) | `users_ref_key`, `merchant_members_user_idx`, `merchants_pkey`    |
| Refresh-token rotation                    | `sessions_refresh_token_hash_key`                                 |
| Active sessions of a user                 | `sessions_user_active_idx` (partial, `revoked_at is null`)        |
| Session family revocation                 | `sessions_family_idx`                                             |
| Merchant API key list                     | `api_keys_merchant_revoked_idx`                                   |
| Admin merchant list, keyset page          | `merchants_status_created_idx`, `merchants_created_idx`           |
| Admin audit list, 90-day window           | per-partition `merchant_id, created_at` index; pruned to 4 months |

Seed sizes: 20k merchants, 60k users, 200k sessions, 40k API keys, 200k audit rows.
