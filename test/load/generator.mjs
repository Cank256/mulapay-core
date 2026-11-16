/**
 * HTTP load generator for the spec 9.1 targets. It runs in its own process, so it does not
 * compete with the server for one event loop. Usage: `node generator.mjs '<json options>'`.
 *
 * Options
 *   baseUrl      http://127.0.0.1:PORT
 *   paths        request paths, used round-robin
 *   method       GET (default) or POST
 *   headers      object
 *   body         object, sent as JSON on POST
 *   uniqueKey    true: a fresh Idempotency-Key header on every request
 *   connections  keep-alive connections (default 32)
 *   mode         "open" (fixed arrival rate, default) or "closed" (as fast as the connections allow)
 *   rate         arrivals per second, open mode
 *   durationMs   measured period
 *   warmupMs     discarded period before it
 *
 * Open mode measures each latency from the moment the request was due, not from when a free
 * connection picked it up, so a slow server cannot hide its queue (coordinated omission).
 * Prints one JSON object: counts by status and latency percentiles in milliseconds.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'undici';

const options = JSON.parse(process.argv[2] ?? '{}');
const {
  baseUrl,
  paths,
  method = 'GET',
  headers = {},
  body,
  uniqueKey = false,
  connections = 32,
  mode = 'open',
  rate = 200,
  durationMs = 10_000,
  warmupMs = 3_000,
} = options;

const pool = new Pool(baseUrl, { connections, pipelining: 1 });
const latencies = [];
const byStatus = {};
let sequence = 0;
let measuring = false;
let failures = 0;
const payload = body === undefined ? undefined : JSON.stringify(body);

async function one(dueAt) {
  const index = sequence++;
  const requestHeaders = { ...headers };
  if (payload !== undefined) requestHeaders['content-type'] = 'application/json';
  if (uniqueKey) requestHeaders['idempotency-key'] = `load-${randomUUID()}`;
  const counted = measuring;
  try {
    const res = await pool.request({
      path: paths[index % paths.length],
      method,
      headers: requestHeaders,
      body: payload,
    });
    await res.body.dump();
    if (counted) {
      latencies.push(performance.now() - dueAt);
      byStatus[res.statusCode] = (byStatus[res.statusCode] ?? 0) + 1;
    }
  } catch {
    if (counted) failures += 1;
  }
}

async function open(untilMs) {
  const interval = 1000 / rate;
  const started = performance.now();
  const inflight = new Set();
  let issued = 0;
  while (performance.now() - started < untilMs) {
    const due = Math.floor((performance.now() - started) / interval) + 1;
    while (issued < due) {
      const dueAt = started + issued * interval;
      const request = one(dueAt).finally(() => inflight.delete(request));
      inflight.add(request);
      issued += 1;
    }
    await sleep(2);
  }
  await Promise.all(inflight);
}

async function closed(untilMs) {
  const started = performance.now();
  const workers = Array.from({ length: connections }, async () => {
    while (performance.now() - started < untilMs) await one(performance.now());
  });
  await Promise.all(workers);
}

const run = mode === 'closed' ? closed : open;
await run(warmupMs);
latencies.length = 0;
for (const key of Object.keys(byStatus)) delete byStatus[key];
failures = 0;
measuring = true;
const startedAt = performance.now();
await run(durationMs);
const elapsedSeconds = (performance.now() - startedAt) / 1000;
await pool.close();

latencies.sort((a, b) => a - b);
const at = (p) =>
  latencies.length === 0
    ? null
    : latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)];
process.stdout.write(
  JSON.stringify({
    mode,
    rate: mode === 'open' ? rate : null,
    connections,
    requests: latencies.length,
    failures,
    byStatus,
    throughput: latencies.length / elapsedSeconds,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: latencies.at(-1) ?? null,
  })
);
