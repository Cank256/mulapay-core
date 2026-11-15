/** `/admin/v1/audit-logs` (spec 7.3): list, verify the hash chain, read one row. */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { MAX_ADMIN_PAGE_LIMIT, pageQuerySchema } from '../../common/pagination/cursor';
import {
  AuditLogsService,
  auditLogSchema,
  chainVerificationSchema,
} from '../../modules/audit/audit-logs.service';
import { refSchema } from '../shared/schemas';

class ListAuditQueryDto extends createZodDto(
  z.strictObject({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    merchant: refSchema.optional(),
    action: z.string().max(100).optional(),
    resourceType: z.string().max(100).optional(),
    resourceId: z.string().max(128).optional(),
    outcome: z.enum(['success', 'denied', 'error']).optional(),
    ...pageQuerySchema(MAX_ADMIN_PAGE_LIMIT),
  })
) {}

class SeqParamDto extends createZodDto(
  z.strictObject({ seq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
) {}

const auditPageSchema = z.object({
  items: z.array(auditLogSchema),
  nextCursor: z.string().nullable(),
});

@ApiTags('Audit')
@Controller('audit-logs')
export class AdminAuditController {
  constructor(private readonly logs: AuditLogsService) {}

  @Get()
  @RequirePermission('audit_logs:read')
  @ApiOperation({ summary: 'Audit rows, newest first, within a date window (default 90 days)' })
  @ApiEnvelopedResponses({ 200: auditPageSchema })
  list(@Query() query: ListAuditQueryDto) {
    return this.logs.list({
      ...query,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('verify')
  @RequirePermission('audit_logs:verify')
  @ApiOperation({ summary: 'Walk the hash chain and report the first break' })
  @ApiEnvelopedResponses({ 200: chainVerificationSchema })
  verify() {
    return this.logs.verify();
  }

  @Get(':seq')
  @RequirePermission('audit_logs:read')
  @ApiOperation({ summary: 'One audit row' })
  @ApiEnvelopedResponses({ 200: auditLogSchema })
  get(@Param() params: SeqParamDto) {
    return this.logs.get(params.seq);
  }
}
