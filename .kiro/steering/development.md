# Development Rules

Use TypeScript strict mode.

Prefer small, focused modules.

Keep controllers thin.

Keep domain and application logic outside controllers.

Use dependency injection.

Prefer explicit interfaces for external dependencies.

Do not introduce unnecessary abstractions.

Do not duplicate business rules across modules.

Do not silently change existing architecture.

Do not add libraries without a clear technical reason.

Do not modify unrelated modules while implementing a feature.

Keep database migrations versioned and reviewable.

Do not manually modify production database structures outside migrations.

Environment-specific configuration must come from configuration/environment management.

Never hard-code credentials or secrets.

Every new module must include appropriate tests.

Every new asynchronous process must define retry and failure behaviour.

Every external integration must define timeout behaviour.

Every database write with financial significance must have clear transactional boundaries.