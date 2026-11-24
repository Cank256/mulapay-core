# MulaPay Core API - Complete Routes Reference

**Version**: 1.0  
**Last Updated**: 2024-11-18  
**Base URLs**:
- Public API: `/v1/*`
- Dashboard API: `/merchant/v1/*`
- Admin API: `/admin/v1/*`

---

## Table of Contents

1. [Public API (Merchant Server-to-Server)](#public-api-v1)
2. [Dashboard API (Merchant Portal)](#dashboard-api-dashboardv1)
3. [Admin API (Platform Operations)](#admin-api-adminv1)
4. [Authentication & Authorization](#authentication--authorization)

---

## Public API (`/v1`)

**Authentication**: API Key (`Authorization: Bearer sk_*`)  
**Audience**: Merchant backend servers  
**CORS**: Disabled (server-to-server only)

### Payments

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `POST` | `/v1/payments` | `payments:write` | Create a new payment |
| `GET` | `/v1/payments` | `payments:read` | List payments with filtering |
| `GET` | `/v1/payments/:ref` | `payments:read` | Retrieve a payment by reference |
| `POST` | `/v1/payments/:ref/cancel` | `payments:write` | Cancel a payment |
| `GET` | `/v1/payments/:ref/timeline` | `payments:read` | Get payment status history |

**Payment Creation**:
```json
POST /v1/payments
Idempotency-Key: <uuid>

{
  "amountMinor": "10000",
  "currency": "UGX",
  "channel": "mobile_money",
  "paymentMethod": { "msisdn": "+256700000001" },
  "description": "Order 1042",
  "returnUrl": "https://example.com/callback",
  "metadata": { "orderId": "1042" }
}
```

### Payouts

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `POST` | `/v1/payouts` | `payouts:write` | Create a new payout |
| `GET` | `/v1/payouts` | `payouts:read` | List payouts with filtering |
| `GET` | `/v1/payouts/:ref` | `payouts:read` | Retrieve a payout by reference |

**Payout Creation**:
```json
POST /v1/payouts
Idempotency-Key: <uuid>

{
  "amountMinor": "50000",
  "currency": "UGX",
  "channel": "mobile_money",
  "destination": {
    "type": "msisdn",
    "value": "+256700000001",
    "name": "John Doe"
  },
  "description": "Payout for services",
  "metadata": { "invoiceId": "INV-001" }
}
```

### Refunds

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `POST` | `/v1/refunds` | `refunds:write` | Create a refund for a payment |
| `GET` | `/v1/refunds` | `refunds:read` | List refunds with filtering |
| `GET` | `/v1/refunds/:ref` | `refunds:read` | Retrieve a refund by reference |

**Refund Creation**:
```json
POST /v1/refunds
Idempotency-Key: <uuid>

{
  "paymentId": "pay_01JBX7Q2M4N8R5T6V9W0XYZABC",
  "amountMinor": "10000",
  "reason": "Customer requested refund",
  "metadata": { "ticketId": "T-123" }
}
```

### Payment Links

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `POST` | `/v1/payment-links` | `payments:write` | Create a payment link |
| `GET` | `/v1/payment-links` | `payments:read` | List payment links |
| `GET` | `/v1/payment-links/:ref` | `payments:read` | Retrieve a payment link |
| `PATCH` | `/v1/payment-links/:ref` | `payments:write` | Update a payment link |
| `POST` | `/v1/payment-links/:ref/deactivate` | `payments:write` | Deactivate a payment link |

### Checkout Sessions

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `POST` | `/v1/checkout-sessions` | `payments:write` | Create a checkout session |
| `GET` | `/v1/checkout-sessions/:ref` | `payments:read` | Retrieve a checkout session |
| `POST` | `/v1/checkout-sessions/:ref/expire` | `payments:write` | Expire a checkout session |

### Transactions

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/v1/transactions` | `transactions:read` | List transactions with filtering |
| `GET` | `/v1/transactions/:ref` | `transactions:read` | Retrieve a transaction |

### Balances

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/v1/balances` | `balances:read` | Get current balances by currency |
| `GET` | `/v1/balance-transactions` | `balances:read` | List balance movements |
| `GET` | `/v1/holds` | `balances:read` | List active holds |

### Settlements

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/v1/settlements` | `settlements:read` | List settlement cycles |
| `GET` | `/v1/settlements/:ref` | `settlements:read` | Retrieve a settlement |
| `GET` | `/v1/settlements/:ref/items` | `settlements:read` | List items in a settlement |

### Events

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/v1/events` | `events:read` | List merchant events (webhooks) |
| `GET` | `/v1/events/:ref` | `events:read` | Retrieve an event |

### Webhooks

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `POST` | `/v1/webhook-endpoints` | `webhooks:write` | Register a webhook endpoint |
| `GET` | `/v1/webhook-endpoints` | `webhooks:read` | List webhook endpoints |
| `GET` | `/v1/webhook-endpoints/:ref` | `webhooks:read` | Retrieve a webhook endpoint |
| `PATCH` | `/v1/webhook-endpoints/:ref` | `webhooks:write` | Update a webhook endpoint |
| `DELETE` | `/v1/webhook-endpoints/:ref` | `webhooks:write` | Delete a webhook endpoint |
| `POST` | `/v1/webhook-endpoints/:ref/rotate-secret` | `webhooks:write` | Rotate webhook secret |

### System

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| `GET` | `/v1/ping` | *public* | Health check |
| `GET` | `/v1/status` | *public* | Public status page (incidents) |

---

## Dashboard API (`/merchant/v1`)

**Authentication**: JWT (cookie or `Authorization: Bearer`)  
**Audience**: Merchant team members via web interface  
**Session**: 10-minute access token, 30-day refresh token

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/merchant/v1/auth/register` | Register new merchant |
| `POST` | `/merchant/v1/auth/login` | Login with email/password |
| `POST` | `/merchant/v1/auth/mfa/verify` | Verify MFA code |
| `POST` | `/merchant/v1/auth/mfa/enroll` | Enroll in MFA |
| `POST` | `/merchant/v1/auth/mfa/disable` | Disable MFA |
| `POST` | `/merchant/v1/auth/refresh` | Refresh access token |
| `POST` | `/merchant/v1/auth/logout` | Logout |
| `POST` | `/merchant/v1/auth/accept-invite` | Accept team invitation |
| `GET` | `/merchant/v1/auth/me` | Get current user |
| `GET` | `/merchant/v1/auth/sessions` | List active sessions |
| `DELETE` | `/merchant/v1/auth/sessions/:id` | Revoke a session |

### Merchant Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/merchant` | Get merchant profile |
| `PATCH` | `/merchant/v1/merchant` | Update merchant profile |

### API Keys

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/api-keys` | List API keys |
| `POST` | `/merchant/v1/api-keys` | Create an API key |
| `POST` | `/merchant/v1/api-keys/:id/roll` | Roll an API key |
| `DELETE` | `/merchant/v1/api-keys/:id` | Revoke an API key |

### Team Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/team` | List team members |
| `POST` | `/merchant/v1/team/invites` | Invite team member |
| `GET` | `/merchant/v1/team/invites` | List pending invites |
| `DELETE` | `/merchant/v1/team/invites/:id` | Cancel invitation |
| `PATCH` | `/merchant/v1/team/:userId` | Update team member role |
| `DELETE` | `/merchant/v1/team/:userId` | Remove team member |

### Payments & Transactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/payments` | List payments (read-only view) |
| `GET` | `/merchant/v1/transactions` | List transactions (read-only view) |

### KYC (Know Your Customer)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/kyc` | Get KYC status |
| `GET` | `/merchant/v1/kyc/requirements` | Get required documents |
| `GET` | `/merchant/v1/kyc/profile` | Get business profile |
| `PUT` | `/merchant/v1/kyc/profile` | Update business profile |
| `GET` | `/merchant/v1/kyc/parties` | List beneficial owners |
| `POST` | `/merchant/v1/kyc/parties` | Add beneficial owner |
| `DELETE` | `/merchant/v1/kyc/parties/:id` | Remove beneficial owner |
| `POST` | `/merchant/v1/kyc/submit` | Submit for KYC review |
| `POST` | `/merchant/v1/kyc/documents/presign` | Get S3 upload URL |
| `POST` | `/merchant/v1/kyc/documents` | Register uploaded document |
| `DELETE` | `/merchant/v1/kyc/documents/:id` | Delete document |

### Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/analytics/overview` | Dashboard overview metrics |
| `GET` | `/merchant/v1/analytics/volume` | Transaction volume over time |
| `GET` | `/merchant/v1/analytics/success-rate` | Success rate by channel |
| `GET` | `/merchant/v1/analytics/channels` | Channel breakdown |

### Settlements

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/settlements` | List settlements |
| `GET` | `/merchant/v1/settlements/:ref` | Get settlement details |
| `GET` | `/merchant/v1/settlements/:ref/items` | List settlement items |
| `GET` | `/merchant/v1/settlements/:ref/statement` | Get settlement statement (PDF) |
| `GET` | `/merchant/v1/settlements/:ref/statement/csv` | Get settlement statement (CSV) |

### Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/merchant/v1/reports` | Request a report |
| `GET` | `/merchant/v1/reports` | List reports |
| `GET` | `/merchant/v1/reports/:ref` | Get report status |
| `GET` | `/merchant/v1/reports/:ref/download` | Download completed report |

**Report Schedules**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/merchant/v1/report-schedules` | Create scheduled report |
| `GET` | `/merchant/v1/report-schedules` | List schedules |
| `GET` | `/merchant/v1/report-schedules/:ref` | Get schedule |
| `PATCH` | `/merchant/v1/report-schedules/:ref` | Update schedule |
| `DELETE` | `/merchant/v1/report-schedules/:ref` | Delete schedule |

### Complaints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/complaints/categories` | List complaint categories |
| `POST` | `/merchant/v1/complaints` | File a complaint |
| `GET` | `/merchant/v1/complaints` | List your complaints |
| `GET` | `/merchant/v1/complaints/:ref` | Get complaint details |
| `POST` | `/merchant/v1/complaints/:ref/messages` | Add message to complaint |
| `POST` | `/merchant/v1/complaints/:ref/close` | Close complaint |

### Disputes

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/disputes` | List disputes |
| `GET` | `/merchant/v1/disputes/:ref` | Get dispute details |
| `POST` | `/merchant/v1/disputes/:ref/evidence` | Submit evidence |

### Webhooks (Dashboard)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/webhook-endpoints` | List webhook endpoints |
| `POST` | `/merchant/v1/webhook-endpoints` | Create webhook endpoint |
| `GET` | `/merchant/v1/webhook-endpoints/:id` | Get endpoint |
| `PATCH` | `/merchant/v1/webhook-endpoints/:id` | Update endpoint |
| `DELETE` | `/merchant/v1/webhook-endpoints/:id` | Delete endpoint |
| `POST` | `/merchant/v1/webhook-endpoints/:id/rotate-secret` | Rotate secret |

**Webhook Deliveries**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/webhook-deliveries` | List delivery attempts |
| `POST` | `/merchant/v1/webhook-deliveries/replay` | Replay events |
| `GET` | `/merchant/v1/webhook-deliveries/:id` | Get delivery details |
| `POST` | `/merchant/v1/webhook-deliveries/:id/retry` | Retry failed delivery |

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/notifications` | List notifications |
| `GET` | `/merchant/v1/notifications/unread-count` | Count unread |
| `POST` | `/merchant/v1/notifications/read-all` | Mark all as read |
| `POST` | `/merchant/v1/notifications/:ref/read` | Mark as read |
| `GET` | `/merchant/v1/notification-preferences` | Get preferences |
| `PATCH` | `/merchant/v1/notification-preferences` | Update preferences |
| `GET` | `/merchant/v1/notification-destinations` | List destinations |
| `PUT` | `/merchant/v1/notification-destinations/:channel` | Set destination |
| `DELETE` | `/merchant/v1/notification-destinations/:channel` | Remove destination |

### Request Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/request-logs` | List API requests |
| `GET` | `/merchant/v1/request-logs/:id` | Get request details |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/merchant/v1/status` | System status |

---

## Admin API (`/admin/v1`)

**Authentication**: JWT (admin role)  
**Audience**: MulaPay operations team  
**Features**: Platform-wide operations, support, compliance

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/admin/v1/auth/login` | Admin login |
| `POST` | `/admin/v1/auth/mfa/verify` | Verify MFA |
| `POST` | `/admin/v1/auth/refresh` | Refresh token |
| `POST` | `/admin/v1/auth/logout` | Logout |
| `GET` | `/admin/v1/auth/me` | Get current admin |
| `POST` | `/admin/v1/auth/step-up` | Re-authenticate for sensitive ops |

### Merchants

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/merchants` | List all merchants |
| `POST` | `/admin/v1/merchants` | Create merchant (onboarding) |
| `GET` | `/admin/v1/merchants/:ref` | Get merchant |
| `PATCH` | `/admin/v1/merchants/:ref` | Update merchant |
| `POST` | `/admin/v1/merchants/:ref/activate` | Activate merchant |
| `POST` | `/admin/v1/merchants/:ref/suspend` | Suspend merchant |
| `POST` | `/admin/v1/merchants/:ref/close` | Close merchant account |
| `GET` | `/admin/v1/merchants/:ref/users` | List merchant users |

### KYC Review

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/kyc/queue` | KYC review queue |
| `GET` | `/admin/v1/kyc/requirements` | List KYC requirement templates |
| `POST` | `/admin/v1/kyc/requirements` | Create requirement |
| `PATCH` | `/admin/v1/kyc/requirements/:id` | Update requirement |
| `DELETE` | `/admin/v1/kyc/requirements/:id` | Delete requirement |
| `GET` | `/admin/v1/kyc/:merchantRef` | Get merchant KYC |
| `POST` | `/admin/v1/kyc/:merchantRef/approve` | Approve KYC |
| `POST` | `/admin/v1/kyc/:merchantRef/reject` | Reject KYC |
| `POST` | `/admin/v1/kyc/:merchantRef/request-info` | Request more info |
| `POST` | `/admin/v1/kyc/:merchantRef/checks` | Run background checks |
| `GET` | `/admin/v1/kyc/:merchantRef/documents/:id/view` | View document |
| `POST` | `/admin/v1/kyc/:merchantRef/documents/:id/verify` | Verify document |

### AML (Anti-Money Laundering)

**Screening & Controls**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/aml/screenings` | List screenings |
| `POST` | `/admin/v1/aml/screenings` | Trigger screening |
| `POST` | `/admin/v1/aml/screenings/:ref/decide` | Decide on screening |
| `GET` | `/admin/v1/aml/rules` | List monitoring rules |
| `POST` | `/admin/v1/aml/rules` | Create rule |
| `PATCH` | `/admin/v1/aml/rules/:code` | Update rule |
| `GET` | `/admin/v1/aml/blocklist` | List blocklist entries |
| `POST` | `/admin/v1/aml/blocklist` | Add to blocklist |
| `DELETE` | `/admin/v1/aml/blocklist/:ref` | Remove from blocklist |
| `GET` | `/admin/v1/aml/blocks` | List merchant blocks |
| `POST` | `/admin/v1/aml/blocks` | Block merchant |
| `POST` | `/admin/v1/aml/blocks/:ref/lift` | Lift block |

**Alerts & Cases**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/aml/alerts` | List AML alerts |
| `GET` | `/admin/v1/aml/alerts/:ref` | Get alert |
| `POST` | `/admin/v1/aml/alerts/:ref/assign` | Assign alert |
| `POST` | `/admin/v1/aml/alerts/:ref/escalate` | Escalate alert |
| `POST` | `/admin/v1/aml/alerts/:ref/resolve` | Resolve alert |
| `GET` | `/admin/v1/aml/cases` | List AML cases |
| `POST` | `/admin/v1/aml/cases` | Create case |
| `GET` | `/admin/v1/aml/cases/:ref` | Get case |
| `PATCH` | `/admin/v1/aml/cases/:ref` | Update case |
| `POST` | `/admin/v1/aml/cases/:ref/str` | File STR (Suspicious Transaction Report) |

### Disputes

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/disputes` | List disputes |
| `POST` | `/admin/v1/disputes` | Create dispute (admin-initiated) |
| `GET` | `/admin/v1/disputes/:ref` | Get dispute |
| `PATCH` | `/admin/v1/disputes/:ref` | Update dispute |
| `POST` | `/admin/v1/disputes/:ref/assign` | Assign dispute |
| `GET` | `/admin/v1/disputes/:ref/notes` | List notes |
| `POST` | `/admin/v1/disputes/:ref/notes` | Add note |
| `POST` | `/admin/v1/disputes/:ref/resolve` | Resolve dispute |

### Complaints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/complaints` | List complaints |
| `GET` | `/admin/v1/complaints/sla-breaches` | List SLA breaches |
| `GET` | `/admin/v1/complaints/categories` | List categories |
| `POST` | `/admin/v1/complaints` | Create complaint (internal) |
| `GET` | `/admin/v1/complaints/:ref` | Get complaint |
| `GET` | `/admin/v1/complaints/:ref/contact` | Get contact info |
| `POST` | `/admin/v1/complaints/:ref/assign` | Assign complaint |
| `POST` | `/admin/v1/complaints/:ref/messages` | Add message |
| `POST` | `/admin/v1/complaints/:ref/escalate` | Escalate complaint |
| `POST` | `/admin/v1/complaints/:ref/resolve` | Resolve complaint |

### Incidents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/incidents` | List incidents |
| `POST` | `/admin/v1/incidents` | Create incident |
| `GET` | `/admin/v1/incidents/:ref` | Get incident |
| `PATCH` | `/admin/v1/incidents/:ref` | Update incident |
| `POST` | `/admin/v1/incidents/:ref/updates` | Post status update |
| `POST` | `/admin/v1/incidents/:ref/resolve` | Resolve incident |
| `POST` | `/admin/v1/incidents/:ref/postmortem` | Add postmortem |

### Ledger & Accounts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/accounts` | List ledger accounts |
| `GET` | `/admin/v1/accounts/:code` | Get account |
| `GET` | `/admin/v1/accounts/:code/statement` | Get account statement |
| `GET` | `/admin/v1/journal-entries` | List journal entries |
| `GET` | `/admin/v1/journal-entries/:ref` | Get journal entry |
| `GET` | `/admin/v1/trial-balance` | Get trial balance |
| `GET` | `/admin/v1/ledger/integrity` | Run integrity check |

### Balances & Holds

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/balances` | List all merchant balances |
| `GET` | `/admin/v1/holds` | List active holds |

### Reconciliation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/reconciliation/status` | Get reconciliation status |
| `GET` | `/admin/v1/reconciliation/runs` | List reconciliation runs |
| `POST` | `/admin/v1/reconciliation/runs` | Trigger reconciliation run |
| `GET` | `/admin/v1/reconciliation/runs/:ref` | Get run details |
| `GET` | `/admin/v1/reconciliation/exceptions` | List exceptions |
| `GET` | `/admin/v1/reconciliation/unresolved` | List unresolved items |
| `GET` | `/admin/v1/reconciliation/history` | Get reconciliation history |
| `GET` | `/admin/v1/reconciliation/pending-resolutions` | List pending resolutions |
| `GET` | `/admin/v1/reconciliation/exceptions/:ref` | Get exception |
| `POST` | `/admin/v1/reconciliation/exceptions/:ref/assign` | Assign exception |
| `POST` | `/admin/v1/reconciliation/exceptions/:ref/notes` | Add note |
| `POST` | `/admin/v1/reconciliation/exceptions/:ref/resolve` | Resolve exception |
| `POST` | `/admin/v1/reconciliation/resolutions/:ref/decide` | Decide on resolution |

**Statements**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/admin/v1/reconciliation/statements` | Upload statement |
| `GET` | `/admin/v1/reconciliation/statements` | List statements |
| `GET` | `/admin/v1/reconciliation/statements/:ref/rows` | Get statement rows |

### Settlement

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/settlement/cycles` | List settlement cycles |
| `POST` | `/admin/v1/settlement/cycles` | Create cycle |
| `POST` | `/admin/v1/settlement/cycles/assign` | Assign transactions to cycles |
| `PATCH` | `/admin/v1/settlement/cycles/:ref` | Update cycle |
| `GET` | `/admin/v1/settlement/payables` | List payables |
| `POST` | `/admin/v1/settlement/batches` | Create settlement batch |
| `GET` | `/admin/v1/settlement/batches` | List batches |
| `GET` | `/admin/v1/settlement/batches/:ref` | Get batch |
| `GET` | `/admin/v1/settlement/batches/:ref/items` | List batch items |
| `GET` | `/admin/v1/settlement/batches/:ref/statement` | Get batch statement |
| `POST` | `/admin/v1/settlement/batches/:ref/submit` | Submit for approval |
| `POST` | `/admin/v1/settlement/batches/:ref/approve` | Approve batch |
| `POST` | `/admin/v1/settlement/batches/:ref/release` | Release batch |
| `POST` | `/admin/v1/settlement/batches/:ref/cancel` | Cancel batch |
| `GET` | `/admin/v1/settlement/destinations` | List destinations |
| `PUT` | `/admin/v1/settlement/destinations` | Update destinations |
| `PUT` | `/admin/v1/settlement/rolling-reserve` | Update rolling reserve |

### Providers & Routing

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/providers` | List providers |
| `PATCH` | `/admin/v1/providers/:id` | Update provider config |
| `GET` | `/admin/v1/providers/:id/balance` | Get provider balance |

**Routing Rules**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/routing-rules` | List routing rules |
| `POST` | `/admin/v1/routing-rules` | Create rule |
| `GET` | `/admin/v1/routing-rules/:ref` | Get rule |
| `PATCH` | `/admin/v1/routing-rules/:ref` | Update rule |
| `DELETE` | `/admin/v1/routing-rules/:ref` | Delete rule |

### Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/ops/overview` | Operations overview |
| `GET` | `/admin/v1/ops/queues` | List BullMQ queues |
| `POST` | `/admin/v1/ops/queues/:name/retry-failed` | Retry failed jobs |
| `POST` | `/admin/v1/ops/queues/:name/pause` | Pause queue |
| `POST` | `/admin/v1/ops/queues/:name/resume` | Resume queue |
| `GET` | `/admin/v1/ops/consumer-cursors` | List event consumer cursors |
| `POST` | `/admin/v1/ops/consumer-cursors/:name/rewind` | Rewind cursor |
| `GET` | `/admin/v1/ops/stuck-transactions` | List stuck transactions |
| `GET` | `/admin/v1/ops/suspense` | List suspense items |

**Feature Flags**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/ops/feature-flags` | List feature flags |
| `POST` | `/admin/v1/ops/feature-flags` | Create flag |
| `PATCH` | `/admin/v1/ops/feature-flags/:key` | Update flag |

**Maintenance Mode**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/ops/maintenance-mode` | Get maintenance status |
| `POST` | `/admin/v1/ops/maintenance-mode` | Enable/disable maintenance |

**Approvals**:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/ops/approvals` | List approval requests |
| `GET` | `/admin/v1/ops/approvals/:ref` | Get approval |
| `POST` | `/admin/v1/ops/approvals/:ref/approve` | Approve request |
| `POST` | `/admin/v1/ops/approvals/:ref/reject` | Reject request |

### Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/notification-templates` | List templates |
| `PUT` | `/admin/v1/notification-templates/:code/:channel` | Update template |
| `POST` | `/admin/v1/notifications/broadcast` | Send broadcast |
| `GET` | `/admin/v1/notifications/deliveries` | List deliveries |
| `GET` | `/admin/v1/notification-destinations` | List destinations |
| `PUT` | `/admin/v1/notification-destinations/:channel` | Set destination |
| `DELETE` | `/admin/v1/notification-destinations/:channel` | Remove destination |

### Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/admin/v1/reports` | Request report |
| `GET` | `/admin/v1/reports` | List reports |
| `GET` | `/admin/v1/reports/:ref` | Get report |
| `GET` | `/admin/v1/reports/:ref/download` | Download report |

### Audit Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/audit-logs` | List audit logs |
| `GET` | `/admin/v1/audit-logs/verify` | Verify audit chain |
| `GET` | `/admin/v1/audit-logs/:seq` | Get log entry |

### Roles & Permissions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/v1/roles` | List admin roles |
| `PATCH` | `/admin/v1/roles/:key` | Update role permissions |

---

## Authentication & Authorization

### API Key Authentication (Public API)

**Header**: `Authorization: Bearer sk_{env}_{keyId}_{secret}`

**Scopes**:
- `payments:read` - Read payments, payment links, checkout sessions
- `payments:write` - Create/modify payments, links, sessions
- `payouts:read` - Read payouts
- `payouts:write` - Create payouts
- `refunds:read` - Read refunds
- `refunds:write` - Create refunds
- `transactions:read` - Read transactions
- `balances:read` - Read balances and holds
- `settlements:read` - Read settlements
- `events:read` - Read merchant events
- `webhooks:read` - Read webhook endpoints and deliveries
- `webhooks:write` - Manage webhook endpoints
- `customers:read` - Read customer data (future)
- `customers:write` - Manage customers (future)
- `disputes:read` - Read disputes
- `disputes:write` - Manage disputes

**Request Signing** (Optional, mandatory for live `payouts:write`):
```
X-MulaPay-Timestamp: 1735689600
X-MulaPay-Signature: v1=<hmac-sha256-hex>

Signing string: timestamp + "." + METHOD + "." + path + "." + sha256(body)
Key: API key signing secret (mpsig_...)
```

### JWT Authentication (Dashboard/Admin)

**Header**: `Authorization: Bearer <jwt>` or cookie `mula_access_token`

**Token Payload**:
```json
{
  "sub": "usr_...",
  "type": "access",
  "merchantId": "mch_...",
  "roles": ["merchant_admin"],
  "sid": "ses_...",
  "mfa": true,
  "amr": ["pwd", "totp"],
  "exp": 1735690200
}
```

**Roles** (Dashboard):
- `merchant_owner` - Full access
- `merchant_admin` - Admin access
- `merchant_developer` - API keys, webhooks, technical
- `merchant_finance` - Payments, payouts, settlements
- `merchant_support` - Complaints, disputes, read-only

**Roles** (Admin):
- `admin_superuser` - Full platform access
- `admin_operations` - Ops, incidents, queues
- `admin_compliance` - KYC, AML, cases
- `admin_finance` - Ledger, reconciliation, settlement
- `admin_support` - Complaints, disputes, merchant support

---

## Rate Limits

| Scope | Limit |
|-------|-------|
| API key writes | 100/min (configurable per key) |
| API key reads | 600/min |
| Merchant payouts | 60/min |
| Dashboard auth routes (unauthenticated) | 10/min per IP |
| Account login attempts | 5 per 15min |
| Global burst bucket | 20 capacity, 10/s refill |

**Headers**:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1735690260
Retry-After: 15  (on 429)
```

---

## Pagination

**Cursor-based** (all list endpoints):

```
GET /v1/payments?limit=25&cursor=eyJrIjpbIjIwMjUtMDEtMDFUMDA6MDA6MDAuMDAwWiIsInBheV94eHgiXX0

Response:
{
  "data": [...],
  "pagination": {
    "nextCursor": "eyJ...",
    "hasMore": true,
    "limit": 25
  }
}
```

**Limits**:
- Default: 25
- Max: 100 (public), 200 (admin)

---

## Idempotency

**Required on**:
- `POST /v1/payments`
- `POST /v1/payouts`
- `POST /v1/refunds`
- `POST /v1/payment-links`
- `POST /v1/checkout-sessions`
- `POST /v1/webhook-endpoints`

**Header**: `Idempotency-Key: <uuid-or-unique-string>`

**Replay window**: 24 hours

**Replay response**: HTTP 200 with `Idempotency-Replayed: true`

---

## Error Responses

```json
{
  "error": {
    "code": "PAYMENT_REQUEST_INVALID",
    "message": "The payment request is not acceptable: amount_too_small",
    "details": {
      "reason": "amount_too_small",
      "minimum": "1000"
    },
    "requestId": "req_01JBX7Q2M4N8R5T6V9W0XYZABC"
  }
}
```

**Common Error Codes**:
- `VALIDATION_FAILED` (400)
- `UNAUTHORIZED` (401)
- `FORBIDDEN` (403)
- `NOT_FOUND` (404)
- `IDEMPOTENCY_KEY_REUSED` (409)
- `REQUEST_IN_PROGRESS` (409)
- `RATE_LIMITED` (429)
- `INTERNAL_ERROR` (500)
- `SERVICE_UNAVAILABLE` (503)

---

## Webhooks

**Events**:
- `payment.created`
- `payment.requires_action`
- `payment.succeeded`
- `payment.failed`
- `payment.expired`
- `payment.cancelled`
- `payout.created`
- `payout.pending_approval`
- `payout.succeeded`
- `payout.failed`
- `payout.expired`
- `payout.cancelled`
- `refund.created`
- `refund.succeeded`
- `refund.failed`
- `refund.cancelled`
- `balance.updated`
- `settlement.created`
- `settlement.paid`
- `dispute.created`
- `dispute.resolved`
- `kyc.approved`
- `kyc.rejected`

**Webhook Signature**:
```
X-MulaPay-Signature: t=1735689600,v1=<hmac-sha256-hex>

Signing string: timestamp + "." + json_body
Key: Webhook endpoint secret (whsec_...)
```

---

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 204 | No Content |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict |
| 422 | Unprocessable Entity |
| 429 | Too Many Requests |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

---

## Summary

**Total Endpoints**: ~250+

- **Public API**: 40+ endpoints (money movement, webhooks)
- **Dashboard API**: 90+ endpoints (merchant portal)
- **Admin API**: 120+ endpoints (platform operations)

**Surfaces**:
- Public: Server-to-server API key authentication
- Dashboard: Session-based JWT authentication
- Admin: Session-based JWT with elevated permissions

All endpoints include:
- Comprehensive OpenAPI documentation
- Request/response schemas
- Error handling
- Rate limiting
- Audit logging
- Monitoring/observability

---

**End of API Routes Documentation**

