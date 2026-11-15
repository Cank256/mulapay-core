# Public API guide

For merchants and the engineers who support them. The reference for every operation is the
OpenAPI document ([openapi/public.json](openapi/public.json), served at `/docs/public/` when
`ENABLE_API_DOCS=true`); this guide covers what applies to all of them. Spec sections 6.11, 7.1,
8.1 to 8.6.

The API is server to server. It allows no browser origin (CORS), so call it from your backend,
never from a web page or an app.

## Environments and keys

A key is `mp_{live|test}_{keyId}_{secret}`: `keyId` is 16 characters, `secret` is 32 random
bytes in hex. A **test** key works in the sandbox and never moves money; a **live** key needs
an active merchant. Test and live data are separate: a test key cannot see live data and the
other way round.

Keys are created in the dashboard (`POST /dashboard/v1/api-keys`). The response shows the full
key, and the key's **signing secret**, once. MulaPay stores only the SHA-256 of the key secret,
so a lost key cannot be recovered: roll it.

- **Scopes** limit a key to route groups: `payments:read`, `payments:write`, `payouts:read`,
  `payouts:write`, `refunds:read`, `refunds:write`, `transactions:read`, `balances:read`,
  `customers:read`, `customers:write`, `settlements:read`, `events:read`, `webhooks:read`,
  `webhooks:write`, `disputes:read`, `disputes:write`. A route needs its scope. A key without
  it gets `403 FORBIDDEN`; no other credential substitutes.
- **Rolling** (`POST /dashboard/v1/api-keys/:id/roll`) issues a new key with the same name,
  scopes, allowlist and limits, and retires the old one after `gracePeriodHours`: 0 (at once)
  to 168 (7 days). A key is rolled once; roll its successor next.
- **Revoking** (`DELETE /dashboard/v1/api-keys/:id`) takes effect immediately on every server.
- **Status** is `active`, `expired` (past its `expiresAt`, including a rolled key after its
  grace period) or `revoked`.
- **IP allowlist**: IPv4 or IPv6 addresses or CIDR networks. A request from another address is
  refused with `401`, the same answer as a wrong key. The address MulaPay sees is the TCP peer,
  or, behind the platform's own proxies only, the address those proxies appended. A
  `X-Forwarded-For`, `X-Real-IP` or `Forwarded` header you send has no effect.
- **Per-key limit**: `rateLimitRpm` replaces the write limit for that key (see below).

Authenticate with `Authorization: Bearer <key>`. Every failure is `401 UNAUTHORIZED` with no
detail. After 30 failed attempts in a minute (per address, per /64 for IPv6) the address gets
`429` for the rest of the minute, valid key or not.

## Request signing

Optional for any key (`signingRequired`), and **mandatory for every key that is live and holds
`payouts:write`**: such a key must sign every request, so a stolen key alone can neither pay out
nor read.

```
X-MulaPay-Timestamp: 1735689600                  unix seconds
X-MulaPay-Signature: v1=<hex hmac-sha256>
signing string:  timestamp + "." + METHOD + "." + path + "." + sha256(rawBody)
key:             the key's signing secret (mpsig_...), as the string it was issued
```

`path` is the request target as you send it: the path and the query string. `rawBody` is the exact
bytes of the body (empty for none). Node.js:

```js
const crypto = require('node:crypto');
function sign(secret, method, pathAndQuery, rawBody = '') {
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${method}.${pathAndQuery}.${bodyHash}`)
    .digest('hex');
  return { 'X-MulaPay-Timestamp': ts, 'X-MulaPay-Signature': `v1=${mac}` };
}
```

A signature is refused if its timestamp is more than 300 seconds from the server's clock, or if
it was already used. Two identical requests signed in the same second have the same signature,
so **a retry must be signed again at least one second later** (the `Idempotency-Key` makes the
retry safe). A signature that is present is always checked, even on a key that does not require
one. Errors: `SIGNATURE_REQUIRED`, `SIGNATURE_TIMESTAMP_INVALID`, `SIGNATURE_INVALID`,
`SIGNATURE_REPLAYED` (all `401`) and `SIGNING_SECRET_MISSING` (`403`: a key issued before signing
existed; roll it).

## Idempotency

`POST` routes that create a resource require `Idempotency-Key` (1 to 255 printable characters):
payments, payment links and checkout sessions today. Same key and same body within 24 hours
returns the first response with `Idempotency-Replayed: true`. The same key with another body is
`409 IDEMPOTENCY_KEY_REUSED`; while the first request is still running, `409 REQUEST_IN_PROGRESS`
with `Retry-After`. A failed request leaves nothing behind, so you may retry it under the same
key.

## Rate limits

Per key, in a sliding minute: 100 writes and 600 reads (`RATE_LIMIT_WRITE_PER_MIN`,
`RATE_LIMIT_READ_PER_MIN`), a burst bucket of 20 refilled at 10 a second, and 60 payouts a
minute per merchant. Limits belong to the key and the merchant: changing your address, headers
or the spelling of a URL does not change them. Every response to an authenticated request carries
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds); a `429`
adds `Retry-After`. A refused request is not counted. If MulaPay's counters are unavailable,
reads still work and writes get `503`.

## Responses, errors, pagination

Success: `{ "success": true, "data": ..., "meta": { "requestId": "..." } }`. Failure:
`{ "success": false, "error": { "code", "message", "details"?, "requestId", "docUrl" } }`. Match on
`code`. Send `X-Request-Id` (8 to 128 characters of `A-Za-z0-9._:-`) to choose the request id.

Lists are newest first, `?limit=` (default 25, at most 100) and `?cursor=` from `nextCursor`;
`nextCursor` is `null` on the last page. A cursor belongs to the filters it was issued with:
changing them is `400 INVALID_CURSOR`. Time windows default to the last 90 days (`from`, `to`; at
most 366 days). Amounts are strings of minor units.

## Events and webhooks

Every state change a merchant cares about becomes an **event**, written in the same database
transaction as the change, so you never see an event for something that did not happen and never
miss one that did. `GET /v1/events` lists them (use it to catch up after downtime). Types:
`payment.created`, `payment.requires_action`, `payment.succeeded`, `payment.failed`,
`payment.expired`, `payment.cancelled`, `refund.*`, `payout.*`, `balance.updated`, `hold.created`,
`hold.released`, `settlement.*`, `dispute.*`, `kyc.*`, `merchant.suspended`, `merchant.activated`,
and `webhook_endpoint.auto_disabled`. The refund, payout, settlement, dispute and KYC events are
emitted once those modules exist (see "What is built").

Register an endpoint with `POST /v1/webhook-endpoints` (`url`, `enabledEvents`, an optional
`description`). The URL must be `https` and reach a public address: private, loopback, link-local
and cloud-metadata addresses are refused when you register and again when MulaPay delivers, and
redirects are not followed. The response carries the signing `secret` once.

**Delivery.** `POST` of the event as JSON. Answer `2xx` within 10 seconds. Headers:

```
MulaPay-Signature: t=1735689600,v1=<hex hmac-sha256 of "t.payload">
MulaPay-Event-Id: evt_...        same on every attempt and replay: deduplicate on it
MulaPay-Event-Type, MulaPay-Delivery-Id, MulaPay-Delivery-Attempt
```

Verify with the endpoint secret over the **raw body**, compare in constant time, and reject a `t`
more than 300 seconds old:

```js
function verify(header, rawBody, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest();
  return header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const given = Buffer.from(p.slice(3), 'hex');
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}
```

**Retries.** An attempt that is not `2xx` is retried after 30 s, 2 min, 10 min, 1 h, 6 h and 24 h
(7 attempts in all), each delay jittered by up to 20%. After the seventh the delivery is
`exhausted`. After 50 consecutive failed attempts the endpoint is `auto_disabled` and you get a
`webhook_endpoint.auto_disabled` event (on your other endpoints, and in `/v1/events`). Re-enable
with `PATCH ... {"status":"active"}`. Delivery is at least once and **not ordered**.

**Secret rotation.** `POST /v1/webhook-endpoints/:ref/rotate-secret` returns a new secret once.
For `graceHours` (default 24, at most 72) deliveries carry two `v1` signatures, one per secret.

**Replay and the delivery log** are in the dashboard: `GET /dashboard/v1/webhook-deliveries`,
`POST .../:id/retry` (one delivery) and `POST .../replay` (by event type and date range, at most
500 a call). A replay is a new delivery of the same event; replays are not deduplicated, so
deduplicate on the event id. The endpoint must be active.

## Sandbox

A payment made with a test key never reaches a provider. It resolves on its own, from
`metadata.simulate` or, without it, from the last two digits of `amountMinor`:

| `metadata.simulate`    | Last two digits | What happens                                                                  |
| ---------------------- | --------------- | ----------------------------------------------------------------------------- |
| `succeed`              | any other       | processing, then `payment.succeeded`; the test balance is credited            |
| `fail`                 | `01`            | `payment.failed`, failure code `sandbox_declined`                             |
| `timeout`              | `02`            | stays `processing` (outcome unknown, no event); `payment.expired` after 120 s |
| `expire`               | `03`            | `payment.expired`, failure code `sandbox_expired`                             |
| `pending_then_succeed` | `04`            | `processing`, then `payment.succeeded` after 5 s                              |

An unknown `simulate` value is `422 PAYMENT_REQUEST_INVALID` in test mode (`simulate_value_invalid`),
so a typo cannot pass for success; in live mode `metadata` is only metadata. The simulator uses
the same state machine, ledger postings, events and webhooks as live payments; transitions are
marked with source `job` and failure codes starting `sandbox_`. The delays are
`SANDBOX_PENDING_SECONDS` and `SANDBOX_TIMEOUT_RESOLVE_SECONDS`.

## Request logs

Every authenticated call is logged without its body: request id, key, method, path (no query
string), route, status, error code, idempotency key, latency, client address, user agent.
`GET /dashboard/v1/request-logs` (permission `request_logs:read`). Logs are buffered and appear
within a few seconds. Calls that failed authentication have no merchant to attach to and are
counted, not logged.

## What is built

| Route group                                                      | State                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `ping`                                                           | built                                                   |
| `payments`, `payment-links`, `checkout-sessions`, `transactions` | built (Phase 4 domain, without the gateway)             |
| `balances`, `balance-transactions`, `holds`                      | built, read only                                        |
| `events`, `webhook-endpoints`                                    | built                                                   |
| `payment-methods`                                                | **not built**: needs routing (Phase 4)                  |
| `refunds`, `payouts`, `payout-batches`                           | **not built**: money movement (Phase 4)                 |
| `customers`                                                      | **not built**: table and PII handling belong to Phase 4 |
| `settlements`                                                    | **not built**: Phase 6                                  |
| `disputes`                                                       | **not built**: Phase 7                                  |

Their scopes exist, and the signing and rate rules for `payouts:write` are enforced by the same
guards the day the routes arrive; `test/integration/request-signing.int-spec.ts` proves them on
a probe route.
