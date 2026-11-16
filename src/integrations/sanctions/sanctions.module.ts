import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { OpenSanctionsScreening } from './opensanctions-screening';
import { SANCTIONS_SCREENING, type SanctionsScreening } from './sanctions-screening.port';
import { UnavailableScreening } from './unavailable-screening';

/** Picks the screening adapter from `SANCTIONS_PROVIDER` (spec 15). */
@Module({
  providers: [
    {
      provide: SANCTIONS_SCREENING,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SanctionsScreening => {
        const adapter = new OpenSanctionsScreening(config);
        return adapter.configured ? adapter : new UnavailableScreening();
      },
    },
  ],
  exports: [SANCTIONS_SCREENING],
})
export class SanctionsModule {}
