/**
 * `npm run start`: one image, three processes, selected by APP_ROLE (spec section 4.1).
 * Each entry point validates the full configuration itself.
 */
const role = process.env.APP_ROLE ?? 'api';
const entryPoints: Record<string, () => Promise<unknown>> = {
  api: () => import('./main.api.js'),
  worker: () => import('./main.worker.js'),
  consumer: () => import('./main.consumer.js'),
};

const load = entryPoints[role];
if (!load) {
  process.stderr.write(`APP_ROLE must be one of api, worker, consumer (got "${role}")\n`);
  process.exit(1);
}
void load();
