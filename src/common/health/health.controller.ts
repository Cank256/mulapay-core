/**
 * Infrastructure probes (spec section 7.4). Unauthenticated, exempt from rate limiting,
 * and never expose configuration or error detail.
 */
import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { ApiRawResponses } from '../http/response-schema.decorator';
import { livenessSchema, readinessSchema, type Liveness, type Readiness } from './health.schemas';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('v1/health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Liveness probe. No dependency checks.' })
  @ApiRawResponses({ 200: livenessSchema })
  liveness(): Liveness {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Readiness probe: database (rw, ro), Redis and the gateway.' })
  @ApiRawResponses({ 200: readinessSchema, 503: readinessSchema })
  async readiness(@Res({ passthrough: true }) reply: FastifyReply): Promise<Readiness> {
    const report = await this.health.checkReadiness();
    if (!report.ready) void reply.status(503);
    return { status: report.ready ? 'ready' : 'not_ready' };
  }
}
