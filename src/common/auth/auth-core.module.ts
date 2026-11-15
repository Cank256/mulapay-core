import { Global, Module } from '@nestjs/common';
import { FieldEncryption } from '../crypto/field-encryption';
import { AccessTokenService } from './access-token.service';
import { PasswordHasher } from './password-hasher';
import { SessionRevocationStore } from './session-revocation.store';
import { TotpService } from './totp.service';

/** Authentication primitives shared by the identity, merchant and auth modules. */
@Global()
@Module({
  providers: [
    AccessTokenService,
    PasswordHasher,
    TotpService,
    SessionRevocationStore,
    FieldEncryption,
  ],
  exports: [
    AccessTokenService,
    PasswordHasher,
    TotpService,
    SessionRevocationStore,
    FieldEncryption,
  ],
})
export class AuthCoreModule {}
