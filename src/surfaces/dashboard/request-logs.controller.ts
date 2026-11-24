/** `/merchant/v1/request-logs` (spec 7.2): the merchant's API request log. No bodies are stored. */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import { scopeOfMerchantUser } from '../../common/auth/merchant-scope';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { RequestLogService } from '../../modules/developer/request-logs/request-log.service';
import {
  requestLogPageSchema,
  requestLogSchema,
} from '../../modules/developer/request-logs/request-log.views';
import { environmentQuerySchema, listRequestLogsSchema } from '../shared/developer.schemas';
import { idParamSchema } from '../shared/schemas';

class ListRequestLogsDto extends createZodDto(listRequestLogsSchema) {}
class EnvironmentDto extends createZodDto(environmentQuerySchema) {}
class IdParamDto extends createZodDto(idParamSchema) {}

@ApiTags('Request logs')
@Controller('request-logs')
export class DashboardRequestLogsController {
  constructor(private readonly logs: RequestLogService) {}

  @Get()
  @RequirePermission('request_logs:read')
  @ApiOperation({ summary: 'API requests made with the merchant’s keys, newest first' })
  @ApiEnvelopedResponses({ 200: requestLogPageSchema })
  list(@Query() query: ListRequestLogsDto, @CurrentMerchantUser() user: MerchantUserPrincipal) {
    const { environment, ...filters } = query;
    return this.logs.list(scopeOfMerchantUser(user, environment), filters);
  }

  @Get(':id')
  @RequirePermission('request_logs:read')
  @ApiOperation({ summary: 'Retrieve one request log entry' })
  @ApiEnvelopedResponses({ 200: requestLogSchema })
  get(
    @Param() params: IdParamDto,
    @Query() query: EnvironmentDto,
    @CurrentMerchantUser() user: MerchantUserPrincipal
  ) {
    return this.logs.get(scopeOfMerchantUser(user, query.environment), params.id);
  }
}
