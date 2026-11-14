/**
 * Vitest (decision D7). Two projects, one command (`npm test`):
 *
 *   unit         src/**\/*.spec.ts         no I/O
 *   integration  test/integration/**\/*.int-spec.ts
 *                real Postgres 16 and Redis 7 via Testcontainers, started once by the
 *                global setup. No hand-prepared database is needed.
 *
 * SWC compiles tests so NestJS gets decorator metadata (esbuild does not emit it).
 */
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

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
