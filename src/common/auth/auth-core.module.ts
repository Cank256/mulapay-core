import { Global, Module } from '@nestjs/common';
import { FieldEncryption } from '../crypto/field-encryption';
import { AuthFailureLimiter } from '../ratelimit/auth-failure-limiter';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RateLimiter } from '../ratelimit/rate-limiter';
import { ApiKeyCache } from './api-key-cache';
import { ApiKeyUsageTracker } from './api-key-usage.tracker';
import { SignatureReplayStore } from './signature-replay.store';
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
    ApiKeyCache,
    ApiKeyUsageTracker,
    SignatureReplayStore,
    RateLimiter,
    RateLimitGuard,
    AuthFailureLimiter,
  ],
  exports: [
    AccessTokenService,
    PasswordHasher,
    TotpService,
    SessionRevocationStore,
    FieldEncryption,
    ApiKeyCache,
    ApiKeyUsageTracker,
    SignatureReplayStore,
    RateLimiter,
    RateLimitGuard,
    AuthFailureLimiter,
  ],
})
export class AuthCoreModule {}
