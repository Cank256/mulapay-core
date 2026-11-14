# MulaPay Core API Engineering Rules

The MulaPay Core API is a financial system.

CORE_API_BUILD_PROMPT.md is the master technical specification.

Financial correctness takes precedence over implementation convenience.

Never modify:
- ledger invariants
- payment state transitions
- idempotency rules
- balance calculations
- payout controls
- reconciliation rules
- security boundaries

merely to make a test pass.

Never silently change an architectural decision.

If implementation conflicts with the specification, stop and report the conflict.

Never mark a financial feature complete without automated tests for its success and failure paths.

Posted ledger entries are immutable.

Financial corrections use compensating or reversing entries.

PostgreSQL is the source of truth for persistent financial state.

Redis is not a source of financial truth.

BullMQ is used for asynchronous coordination and background processing.

Provider callbacks are treated as external events and must be validated.

All financial operations require idempotency protection.

All external provider interactions require explicit failure and ambiguous-outcome handling.

Prefer explicit domain services over hidden business logic.

Keep controllers thin.

Keep financial rules inside domain/application services.

Do not couple the Core API to undocumented internals of the Provider Gateway.

Do not implement unrelated modules during a phase.

Every phase must leave the repository buildable and testable.

---

# Repository guide

The specification lives at `docs/CORE_API_BUILD_PROMPT.md`. Build order is spec section 14.

## Current phase

Phase 0 (foundation) is in place. No business modules exist. Next is Phase 1
(identity and merchants). Open questions are listed in `docs/ARCHITECTURE.md`
("Phase 0 decisions to confirm") and `docs/DATABASE.md` (table ownership).

## Commands

- `npm run typecheck`, `npm run lint`, `npm run format:check`: must pass with zero warnings.
- `npm test`: unit (`src/**/*.spec.ts`) and integration (`test/integration/**/*.int-spec.ts`).
  Integration tests start Postgres 16 and Redis 7 with Testcontainers; set `DOCKER_HOST`
  if Docker is not on the default socket (see README).
- `npm run test:coverage`: 80% overall; 100% on `src/modules/{ledger,balances,holds}` and
  `src/common/money`.
- `npm run db:generate` then `npm run db:migrate`. Never `drizzle-kit migrate` or `push`.

## Conventions

- Config: read only through the injected `APP_CONFIG` (`src/config/env.schema.ts`). New
  variables go in the schema and `.env.example` together.
- Errors: throw `AppError(code)` with a code from `src/common/errors/catalogue.ts`. Add new
  codes to the catalogue in the phase that needs them.
- Routes: every route declares its response schemas with `@ApiEnvelopedResponses` or
  `@ApiRawResponses`. DTOs use strict Zod schemas via `createZodDto`.
- Controllers live under `src/surfaces/{public,dashboard,admin}` only.
- Logging: inject `ROOT_LOGGER`; never `console`. Never log bodies, secrets or PII.
- Transactions: `UnitOfWork.run`. No HTTP, S3 or queue calls inside it.
- SQL: repositories only, drizzle `sql` tag or `$n` placeholders. Lint rejects interpolation.
- Time: inject `CLOCK`; tests use `test/support/fixed-clock.ts`.
- Queue jobs: implement `QueueProcessor`, register in `src/jobs/jobs.module.ts`, keep
  payloads to identifiers, and make processing idempotent.
- Dependency injection: use explicit `@Inject(TOKEN)` for non-class providers.
