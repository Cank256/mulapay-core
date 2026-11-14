# Security Rules

Treat all external input as untrusted.

Validate request payloads using the project's validation approach.

Authentication and authorization must be enforced at the API boundary.

Apply least privilege.

Do not expose secrets in:
- source code
- logs
- API responses
- error messages
- test fixtures

API keys and authentication credentials must be stored securely.

Sensitive operations require appropriate authorization and authentication controls.

Admin functionality must have stronger security controls than ordinary merchant functionality.

Audit security-sensitive actions.

Protect webhook endpoints against:
- forged events
- replay attacks
- duplicate delivery
- unauthorized access

Do not log:
- passwords
- API secrets
- private keys
- full authentication tokens
- sensitive payment credentials

Use structured logging.

Use correlation/request IDs for traceability.

Do not bypass authorization in tests or production code merely to simplify implementation.