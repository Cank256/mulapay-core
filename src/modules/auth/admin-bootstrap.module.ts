import { Module, type DynamicModule } from '@nestjs/common';
import type { Logger } from 'pino';
import { AuditModule } from '../../common/audit/audit.module';
import { PasswordHasher } from '../../common/auth/password-hasher';
import { TotpService } from '../../common/auth/totp.service';
import type { Clock } from '../../common/clock/clock';
import { CommonModule } from '../../common/common.module';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { DatabaseModule } from '../../common/db/database.module';
import type { AppConfig } from '../../config/configuration';
import { RolesRepository } from '../identity/roles.repository';
import { UsersRepository } from '../identity/users.repository';
import { AdminBootstrapService } from './admin-bootstrap.service';

/** Minimal context for `npm run seed:admin`: database and audit only, no HTTP or Redis. */
@Module({})
export class AdminBootstrapModule {
  static forRoot(config: AppConfig, logger: Logger, clock?: Clock): DynamicModule {
    return {
      module: AdminBootstrapModule,
      imports: [CommonModule.forRoot(config, logger, clock), DatabaseModule, AuditModule],
      providers: [
        UsersRepository,
        RolesRepository,
        PasswordHasher,
        TotpService,
        FieldEncryption,
        AdminBootstrapService,
      ],
      exports: [AdminBootstrapService],
    };
  }
}
