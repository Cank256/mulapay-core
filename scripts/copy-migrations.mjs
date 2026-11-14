// Copies SQL migrations next to the compiled migrator so `node dist/db/migrate.js`
// works in the production image, which has no TypeScript sources.
import { cpSync, existsSync } from 'node:fs';

const source = 'src/db/migrations';
const target = 'dist/db/migrations';

if (!existsSync(source)) {
  process.stderr.write(`copy-migrations: ${source} does not exist\n`);
  process.exit(1);
}
cpSync(source, target, { recursive: true });
cpSync('src/db/bootstrap', 'dist/db/bootstrap', { recursive: true });
