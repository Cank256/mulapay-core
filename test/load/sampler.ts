/**
 * Resource sampler for the load and soak runs. Every sample records what the task asks to be
 * watched: database connections and saturation, Redis memory and key count, queue depth,
 * worker busyness, and per-process memory, CPU and file descriptors. A run is judged on the
 * trend across samples (see `trend`), not on any single reading, because a leak is a slope.
 */
import { execFileSync } from 'node:child_process';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { QUEUE_DEFINITIONS, QUEUE_PREFIX } from '../../src/common/queue/queue.definitions';

export interface ProcessSample {
  readonly name: string;
  readonly rssMb: number;
  readonly cpuPercent: number;
  readonly fds: number | null;
}

export interface Sample {
  readonly atSeconds: number;
  readonly processes: readonly ProcessSample[];
  readonly db: {
    readonly connections: number;
    readonly active: number;
    readonly idleInTransaction: number;
    readonly waitingOnLocks: number;
    readonly longestTransactionSeconds: number;
    readonly maxConnections: number;
    readonly deadlocks: number;
    readonly cacheHitPercent: number;
    readonly tempFiles: number;
    readonly committed: number;
    readonly rolledBack: number;
    readonly byApplication: Record<string, number>;
  };
  readonly redis: {
    readonly usedMemoryMb: number;
    readonly keys: number;
    readonly clients: number;
    readonly opsPerSecond: number;
    readonly evictedKeys: number;
  };
  readonly queues: Record<
    string,
    { waiting: number; active: number; delayed: number; failed: number }
  >;
  readonly containers: Record<string, { cpuPercent: number; memoryMb: number }>;
}

function ps(pid: number): { rssMb: number; cpu: number } | null {
  try {
    const out = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    const [rss, cpu] = out.split(/\s+/).map(Number);
    return rss === undefined || cpu === undefined ? null : { rssMb: rss / 1024, cpu };
  } catch {
    return null;
  }
}

function fdCount(pid: number): number | null {
  try {
    const out = execFileSync('lsof', ['-n', '-P', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out.split('\n').length - 2;
  } catch {
    return null;
  }
}

function dockerStats(
  ids: Record<string, string>
): Record<string, { cpuPercent: number; memoryMb: number }> {
  const result: Record<string, { cpuPercent: number; memoryMb: number }> = {};
  try {
    const out = execFileSync(
      'docker',
      [
        'stats',
        '--no-stream',
        '--format',
        '{{.ID}} {{.CPUPerc}} {{.MemUsage}}',
        ...Object.values(ids),
      ],
      { encoding: 'utf8', timeout: 30_000 }
    );
    for (const line of out.trim().split('\n')) {
      const [id, cpu, mem] = line.split(/\s+/);
      const name = Object.entries(ids).find(
        ([, v]) => v.startsWith(id ?? '') || (id ?? '').startsWith(v.slice(0, 12))
      )?.[0];
      if (!name || !cpu || !mem) continue;
      const used = /([\d.]+)(MiB|GiB|KiB)/.exec(mem);
      const mb = used
        ? Number(used[1]) * (used[2] === 'GiB' ? 1024 : used[2] === 'KiB' ? 1 / 1024 : 1)
        : 0;
      result[name] = { cpuPercent: Number.parseFloat(cpu), memoryMb: mb };
    }
  } catch {
    // docker stats is optional detail
  }
  return result;
}

export class ResourceSampler {
  private readonly queues: Queue[] = [];
  private pg!: Client;
  private redis!: Redis;
  private startedAt = Date.now();

  constructor(
    private readonly options: {
      readonly postgresUrl: string;
      readonly redisUrl: string;
      readonly queuePrefix: string;
      readonly processes: Record<string, number>;
      readonly containers?: Record<string, string>;
      readonly fdEveryNth?: number;
    }
  ) {}

  private count = 0;

  async start(): Promise<void> {
    this.pg = new Client({ connectionString: this.options.postgresUrl });
    await this.pg.connect();
    await this.pg.query('set statement_timeout = 0');
    this.redis = new Redis(this.options.redisUrl, { maxRetriesPerRequest: 2 });
    for (const definition of QUEUE_DEFINITIONS) {
      this.queues.push(
        new Queue(definition.name, {
          connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
          prefix: this.options.queuePrefix,
        })
      );
    }
    this.startedAt = Date.now();
  }

  /** Keys by their first two `:`-separated segments (up to `limit` scanned), with how many have no expiry. */
  async keyBreakdown(
    limit = 50_000
  ): Promise<Record<string, { keys: number; withoutExpiry: number }>> {
    const result: Record<string, { keys: number; withoutExpiry: number }> = {};
    let cursor = '0';
    let scanned = 0;
    do {
      const [next, batch] = await this.redis.scan(cursor, 'COUNT', 500);
      cursor = next;
      for (const key of batch) {
        scanned += 1;
        const prefix = key
          .split(':')
          .slice(0, 2)
          .join(':')
          .replace(/[0-9a-f-]{8,}.*$/i, '*');
        const entry = (result[prefix] ??= { keys: 0, withoutExpiry: 0 });
        entry.keys += 1;
        if ((await this.redis.ttl(key)) === -1) entry.withoutExpiry += 1;
      }
    } while (cursor !== '0' && scanned < limit);
    return result;
  }

  async stop(): Promise<void> {
    await Promise.all(this.queues.map((q) => q.close()));
    await this.pg.end();
    this.redis.disconnect();
  }

  async sample(): Promise<Sample> {
    this.count += 1;
    const processes: ProcessSample[] = [];
    for (const [name, pid] of Object.entries(this.options.processes)) {
      const stats = ps(pid);
      if (!stats) continue;
      const withFds = this.count % (this.options.fdEveryNth ?? 3) === 1;
      processes.push({
        name,
        rssMb: stats.rssMb,
        cpuPercent: stats.cpu,
        fds: withFds ? fdCount(pid) : null,
      });
    }

    const connections = await this.pg.query(
      `select count(*)::int as total,
              count(*) filter (where state = 'active')::int as active,
              count(*) filter (where state like 'idle in transaction%')::int as idle_in_tx,
              count(*) filter (where wait_event_type = 'Lock')::int as waiting,
              coalesce(max(extract(epoch from now() - xact_start)) filter (where xact_start is not null and pid <> pg_backend_pid()), 0)::float as longest_tx,
              (select setting::int from pg_settings where name = 'max_connections') as max_connections
         from pg_stat_activity where datname = current_database() and usename in ('mulapay_core_rw', 'mulapay_core_ro')`
    );
    const byApplication = await this.pg.query(
      `select application_name, count(*)::int as n from pg_stat_activity
        where datname = current_database() and usename in ('mulapay_core_rw', 'mulapay_core_ro') group by 1`
    );
    const database = await this.pg.query(
      `select deadlocks::int, temp_files::int, xact_commit::bigint::text as commit, xact_rollback::bigint::text as rollback,
              case when blks_hit + blks_read = 0 then 100 else 100.0 * blks_hit / (blks_hit + blks_read) end::float as hit
         from pg_stat_database where datname = current_database()`
    );
    const row = connections.rows[0] as Record<string, number>;
    const stat = database.rows[0] as Record<string, string | number>;

    const info = await this.redis.info();
    const field = (name: string): number =>
      Number(new RegExp(`^${name}:(\\S+)`, 'm').exec(info)?.[1] ?? 0);
    const keys = await this.redis.dbsize();

    const queues: Sample['queues'] = {};
    for (const queue of this.queues) {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      queues[queue.name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    }

    return {
      atSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      processes,
      db: {
        connections: row.total ?? 0,
        active: row.active ?? 0,
        idleInTransaction: row.idle_in_tx ?? 0,
        waitingOnLocks: row.waiting ?? 0,
        longestTransactionSeconds: row.longest_tx ?? 0,
        maxConnections: row.max_connections ?? 0,
        deadlocks: Number(stat.deadlocks ?? 0),
        cacheHitPercent: Number(stat.hit ?? 0),
        tempFiles: Number(stat.temp_files ?? 0),
        committed: Number(stat.commit ?? 0),
        rolledBack: Number(stat.rollback ?? 0),
        byApplication: Object.fromEntries(
          byApplication.rows.map((r: { application_name: string; n: number }) => [
            r.application_name,
            r.n,
          ])
        ),
      },
      redis: {
        usedMemoryMb: field('used_memory') / 1048576,
        keys,
        clients: field('connected_clients'),
        opsPerSecond: field('instantaneous_ops_per_sec'),
        evictedKeys: field('evicted_keys'),
      },
      queues,
      containers: this.options.containers ? dockerStats(this.options.containers) : {},
    };
  }
}

/** Least-squares slope of `values` against sample index, per sample. */
export function slope(values: readonly number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  return den === 0 ? 0 : num / den;
}

export interface Trend {
  readonly first: number;
  readonly last: number;
  readonly max: number;
  readonly perHour: number;
}

/** Growth of a series over the run, measured on the second half so warm-up does not count as a leak. */
export function trend(values: readonly number[], secondsPerSample: number): Trend {
  const half = values.slice(Math.floor(values.length / 2));
  return {
    first: values[0] ?? 0,
    last: values.at(-1) ?? 0,
    max: Math.max(...values, 0),
    perHour: slope(half) * (3600 / secondsPerSample),
  };
}

export const QUEUE_NAMESPACE = QUEUE_PREFIX;
