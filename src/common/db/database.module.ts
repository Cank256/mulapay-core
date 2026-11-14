import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/configuration';
import * as schema from '../../db/schema';
import { APP_CONFIG, ROOT_LOGGER } from '../tokens';
import type { Database } from './database.types';
import { closeDatabasePools, createDatabasePools, type DatabasePools } from './pools';
import { DB_POOLS, DB_REPLICA, DB_RO, DB_RW } from './tokens';
import { UnitOfWork } from './unit-of-work';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_POOLS) private readonly pools: DatabasePools) {}

  async onApplicationShutdown(): Promise<void> {
    await closeDatabasePools(this.pools);
  }
}

const database = (pools: DatabasePools, name: keyof DatabasePools): Database =>
  drizzle({ client: pools[name], schema });

@Global()
@Module({
  providers: [
    {
      provide: DB_POOLS,
      inject: [APP_CONFIG, ROOT_LOGGER],
      useFactory: (config: AppConfig, logger: Logger) => createDatabasePools(config, logger),
    },
    { provide: DB_RW, inject: [DB_POOLS], useFactory: (p: DatabasePools) => database(p, 'rw') },
    { provide: DB_RO, inject: [DB_POOLS], useFactory: (p: DatabasePools) => database(p, 'ro') },
    {
      provide: DB_REPLICA,
      inject: [DB_POOLS],
      useFactory: (p: DatabasePools) => database(p, 'replica'),
    },
    UnitOfWork,
    DatabaseLifecycle,
  ],
  exports: [DB_POOLS, DB_RW, DB_RO, DB_REPLICA, UnitOfWork],
})
export class DatabaseModule {}
