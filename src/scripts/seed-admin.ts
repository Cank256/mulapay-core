/**
 * `npm run seed:admin -- --email ops@mulapay.com --name "Ops Admin" [--role super_admin]`
 *
 * Bootstraps a staff user (spec section 13). Prints the one-time password and the TOTP
 * enrollment URI once, to stdout only; neither is logged or stored in plaintext. Run it
 * from a trusted terminal and move the values into the admin's password manager and
 * authenticator app.
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { createLogger } from '../common/logging/logger';
import { STAFF_ROLES, type StaffRole } from '../common/authz/permissions';
import { getConfig, loadDotEnv } from '../config/configuration';
import { AdminBootstrapModule } from '../modules/auth/admin-bootstrap.module';
import {
  AdminBootstrapError,
  AdminBootstrapService,
} from '../modules/auth/admin-bootstrap.service';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } },
  });
  const role = (values.role ?? 'super_admin') as StaffRole;
  if (!values.email || !values.name || !STAFF_ROLES.includes(role)) {
    process.stderr.write(
      `usage: npm run seed:admin -- --email <email> --name <name> [--role ${STAFF_ROLES.join('|')}]\n`
    );
    return 2;
  }
  loadDotEnv();
  const config = getConfig();
  const logger = createLogger({ ...config, LOG_LEVEL: 'warn' });
  const app = await NestFactory.createApplicationContext(
    AdminBootstrapModule.forRoot(config, logger),
    {
      logger: false,
      abortOnError: false,
    }
  );
  try {
    const admin = await app.get(AdminBootstrapService).bootstrap({
      email: values.email.trim().toLowerCase(),
      name: values.name.trim(),
      role,
    });
    process.stdout.write(
      [
        `Staff user created: ${admin.userId} (${admin.email}, role ${admin.role})`,
        '',
        'Shown once. Store these now:',
        `  password:    ${admin.password}`,
        `  TOTP secret: ${admin.totpSecret}`,
        `  TOTP URI:    ${admin.otpauthUri}`,
        '',
      ].join('\n')
    );
    return 0;
  } catch (error) {
    if (error instanceof AdminBootstrapError) {
      process.stderr.write(`seed:admin: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `seed:admin failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
);
