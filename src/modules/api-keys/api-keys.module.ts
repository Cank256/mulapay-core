import { Module } from '@nestjs/common';
import { API_KEY_AUTHENTICATOR } from '../../common/auth/principal';
import { MerchantsModule } from '../merchants/merchants.module';
import { DbApiKeyAuthenticator } from './api-key-authenticator.service';
import { ApiKeysRepository } from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';

/** API key issuance, rotation, revocation and authentication (spec 6.11). */
@Module({
  imports: [MerchantsModule],
  providers: [
    ApiKeysRepository,
    ApiKeysService,
    DbApiKeyAuthenticator,
    { provide: API_KEY_AUTHENTICATOR, useExisting: DbApiKeyAuthenticator },
  ],
  exports: [ApiKeysService, API_KEY_AUTHENTICATOR],
})
export class ApiKeysModule {}
