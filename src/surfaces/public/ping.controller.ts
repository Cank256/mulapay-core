/**
 * `GET /v1/ping` (spec 7.1): confirms an API key works and says which merchant and
 * environment it belongs to. The rest of the public API arrives in Phases 4 to 7.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentApiKey } from '../../common/auth/current-principal.decorator';
import type { ApiKeyPrincipal } from '../../common/auth/principal';
import { Authenticated } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';

const pingSchema = z.object({
  ok: z.literal(true),
  merchantId: z.string(),
  environment: z.enum(['test', 'live']),
  apiKeyId: z.string(),
});

@ApiTags('Ping')
@Controller('ping')
export class PingController {
  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Check that the API key is valid' })
  @ApiEnvelopedResponses({ 200: pingSchema })
  ping(@CurrentApiKey() key: ApiKeyPrincipal) {
    return {
      ok: true as const,
      merchantId: key.merchant.ref,
      environment: key.environment,
      apiKeyId: key.apiKeyRef,
    };
  }
}
