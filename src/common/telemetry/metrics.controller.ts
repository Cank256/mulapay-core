/**
 * `GET /metrics` (spec section 10). Registered only when METRICS_TOKEN is set, and
 * protected by `Authorization: Bearer <METRICS_TOKEN>`, as in the gateway.
 */
import { Controller, Get, Header, Headers, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../config/configuration';
import { AppError } from '../errors/app-error';
import { RawResponse } from '../http/response-schema.decorator';
import { APP_CONFIG } from '../tokens';
import { isAuthorizedMetricsRequest } from './metrics-auth';
import { MetricsService } from './metrics.service';

@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService
  ) {}

  @Get()
  @RawResponse()
  @Header('Cache-Control', 'no-store')
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<string> {
    const token = this.config.METRICS_TOKEN;
    if (!token || !isAuthorizedMetricsRequest(authorization, token)) {
      throw new AppError('UNAUTHORIZED');
    }
    void reply.type(this.metrics.contentType);
    return this.metrics.render();
  }
}
