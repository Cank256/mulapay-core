# Testing Rules

Do not consider a feature complete because the application compiles.

Tests must cover both successful and failure paths.

Financial code requires stronger testing than ordinary CRUD functionality.

Test:
- business rules
- authorization
- state transitions
- idempotency
- concurrency
- database constraints
- transaction boundaries
- retries
- duplicate events
- ambiguous provider outcomes
- reconciliation
- reversal logic

Use unit tests for isolated domain/application behaviour.

Use integration tests for database behaviour.

Use Testcontainers where real PostgreSQL or Redis behaviour matters.

Do not mock database behaviour when the behaviour being tested depends on PostgreSQL constraints or transactions.

Financial invariants must have automated tests.

Important state machines must reject invalid transitions.

Repeated external events must not create duplicate financial effects.

Before declaring a phase complete:
- TypeScript compilation must pass.
- Linting must pass.
- Unit tests must pass.
- Relevant integration tests must pass.
- Database migrations must apply successfully.
- No unresolved architectural conflict may remain.