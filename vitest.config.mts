/**
 * Vitest (decision D7). Two projects, one command (`npm test`), and a third for load (`npm run test:load`):
 *
 *   unit         src/**\/*.spec.ts         no I/O
 *   load         test/load/**\/*.load-spec.ts (only with LOAD=1): the spec 9.1 targets
 *   integration  test/integration/**\/*.int-spec.ts
 *                real Postgres 16 and Redis 7 via Testcontainers, started once by the
 *                global setup. No hand-prepared database is needed.
 *
 * SWC compiles tests so NestJS gets decorator metadata (esbuild does not emit it).
 */
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** The load project (`npm run test:load`) is left out of `npm test`: it takes minutes and wants a quiet machine. */
const loadProject = {
  extends: true,
  test: {
    name: 'load',
    include: ['test/load/**/*.load-spec.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
  },
};
/**
 * Chaos and disaster-recovery suites (`npm run test:chaos`, CHAOS=1): they kill and restart the
 * Postgres and Redis containers, so they own their containers (fixed host ports, see
 * global-setup) and never run with `npm test`. Files run one at a time.
 */
const chaosProject = {
  extends: true,
  test: {
    name: 'chaos',
    include: ['test/chaos/**/*.chaos-spec.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
  },
};

const ONE_HUNDRED = { lines: 100, functions: 100, branches: 100, statements: 100 };

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.int-spec.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      ...(process.env.LOAD === '1' ? [loadProject] : []),
      ...(process.env.CHAOS === '1' ? [chaosProject] : []),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        // Process entry points and CLI scripts are exercised by running them, not by tests.
        'src/main*.ts',
        'src/db/migrate.ts',
        'src/scripts/**',
        'src/common/telemetry/register.ts',
      ],
      // Spec section 12: 80% overall, 100% on the money-critical modules.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        'src/modules/ledger/**': ONE_HUNDRED,
        'src/modules/balances/**': ONE_HUNDRED,
        'src/modules/holds/**': ONE_HUNDRED,
        'src/common/money/**': ONE_HUNDRED,
      },
    },
  },
});
