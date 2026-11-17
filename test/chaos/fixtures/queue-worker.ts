/**
 * A BullMQ worker in its own process, for the worker-kill chaos test. It uses BullMQ's default
 * lock and stall settings, exactly as `WorkerHost` does, and an idempotent effect (one row per job
 * key), so a job that is delivered twice leaves one effect and a `runs` count of two.
 */
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Client } from 'pg';

async function main(): Promise<void> {
  const { REDIS_URL, PG_URL, QUEUE, PREFIX, WORK_MS } = process.env;
  if (!REDIS_URL || !PG_URL || !QUEUE || !PREFIX) throw new Error('missing worker environment');

  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker(
    QUEUE,
    async (job) => {
      const key = (job.data as { key: string }).key;
      process.stdout.write(`started ${key}\n`);
      await pg.query(
        `insert into public.chaos_effects (key, runs) values ($1, 1)
         on conflict (key) do update set runs = public.chaos_effects.runs + 1`,
        [key]
      );
      await new Promise((resolve) => setTimeout(resolve, Number(WORK_MS ?? 5000)));
      await pg.query('update public.chaos_effects set finished = true where key = $1', [key]);
    },
    { connection, prefix: PREFIX, concurrency: 4 }
  );

  const stop = async (): Promise<void> => {
    await worker.close();
    await pg.end();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
}

void main();
