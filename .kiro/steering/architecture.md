# Architecture Rules

MulaPay uses a service-oriented architecture.

Core API:
- owns business logic
- owns financial state
- owns payment state
- owns merchant state
- owns ledger
- owns balances
- owns reconciliation

Provider Gateway:
- communicates with MTN Mobile Money
- communicates with Airtel Money
- communicates with card/payment providers
- handles provider authentication
- handles provider callbacks
- handles provider status queries
- normalizes provider responses
- handles provider-specific retries and errors

The Core API must not implement provider-specific communication logic.

The Core API communicates with the Provider Gateway through an explicit integration contract.

Do not couple Core business logic to undocumented Gateway implementation details.

PostgreSQL is the source of truth for persistent financial state.

Redis is not a financial source of truth.

BullMQ is for asynchronous processing and coordination.

Controllers must remain thin.

Business rules belong in application/domain services.

Infrastructure concerns belong in infrastructure modules.

External integrations must sit behind explicit interfaces.