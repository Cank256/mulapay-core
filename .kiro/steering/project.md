# MulaPay Core API

MulaPay Core API is the central business and financial backend for the MulaPay payment platform.

Technology:
- NestJS
- Fastify
- TypeScript
- PostgreSQL
- Drizzle ORM
- Redis
- BullMQ
- Zod
- Pino
- OpenTelemetry
- Vitest
- Testcontainers

The Core API owns:
- merchants
- users and permissions
- payments
- collections
- payouts
- refunds
- financial accounts
- double-entry ledger
- balances
- holds
- reconciliation
- settlement
- developer API
- API keys
- webhooks
- notifications
- KYC
- AML
- complaints
- incidents
- audit
- reporting

The Provider Gateway is a separate service.

The Core API owns business and financial decisions.

The Provider Gateway owns communication with payment providers.

docs/CORE_API_BUILD_PROMPT.md is the master technical specification.

When this steering guidance conflicts with the master specification, stop and identify the conflict rather than silently choosing a solution.