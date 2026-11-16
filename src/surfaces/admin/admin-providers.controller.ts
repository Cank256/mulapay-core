/**
 * `/admin/v1/providers` and `/routing-rules` (spec 7.3): provider switches, health and notes, the
 * provider float balance (read through the gateway), and routing rule edits. Everything that
 * changes needs `ops:manage` and step-up. A change that would leave a currency without a route,
 * and every rule deletion, becomes an approval request (202) instead of taking effect.
 * Nothing consults these yet: the router that reads them is Phase 4.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { Audited } from '../../common/audit/audited.decorator';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { AppError } from '../../common/errors/app-error';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import {
  approvalRequiredSchema,
  providerBalanceSchema,
  providerSchema,
  providersSchema,
  ruleSchema,
  rulesSchema,
  toApproval,
  toProvider,
  toRule,
} from '../../modules/operations/ops.views';
import { ProviderOpsService } from '../../modules/operations/provider-ops.service';
import { RoutingRulesService } from '../../modules/operations/routing-rules.service';
import {
  createRuleSchema,
  deleteRuleSchema,
  patchProviderSchema,
  patchRuleSchema,
  providerBalanceQuerySchema,
  providerParamSchema,
  ruleListSchema,
} from '../shared/support.schemas';
import { refParamSchema } from '../shared/schemas';

class ProviderParamDto extends createZodDto(providerParamSchema) {}
class PatchProviderDto extends createZodDto(patchProviderSchema) {}
class BalanceQueryDto extends createZodDto(providerBalanceQuerySchema) {}
class RuleListDto extends createZodDto(ruleListSchema) {}
class CreateRuleDto extends createZodDto(createRuleSchema) {}
class PatchRuleDto extends createZodDto(patchRuleSchema) {}
class DeleteRuleDto extends createZodDto(deleteRuleSchema) {}
class RefDto extends createZodDto(refParamSchema) {}

const staffOf = (s: StaffPrincipal) => ({ userId: s.userId, userRef: s.userRef });

@ApiTags('Providers')
@Controller('providers')
export class AdminProvidersController {
  constructor(private readonly providers: ProviderOpsService) {}

  @Get()
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'Providers: switch, health, currencies, enabled routing rules' })
  @ApiEnvelopedResponses({ 200: providersSchema })
  async list() {
    return { items: (await this.providers.list()).map(toProvider) };
  }

  @Patch(':id')
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('provider.updated', 'provider')
  @ApiOperation({
    summary: 'Enable, disable, set health or a note',
    description:
      'Disabling (or marking down) a provider that is the only enabled route for a currency answers 202 with an approval request and changes nothing until a second person approves; give a `reason`.',
  })
  @ApiEnvelopedResponses({ 200: providerSchema, 202: approvalRequiredSchema })
  async patch(
    @Param() p: ProviderParamDto,
    @Body() body: PatchProviderDto,
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const result = await this.providers.update(p.id, body, staffOf(staff));
    if (result.kind === 'applied') return toProvider(result.value);
    void reply.status(202);
    return {
      approvalRequired: true as const,
      approval: toApproval({ row: result.approval, requestedByRef: staff.userRef }),
    };
  }

  @Get(':id/balance')
  @RequirePermission('ops:read')
  @ApiOperation({
    summary: 'The provider balance as the gateway reports it',
    description: 'Minor units. `503` when the gateway does not answer.',
  })
  @ApiEnvelopedResponses({ 200: providerBalanceSchema })
  async balance(@Param() p: ProviderParamDto, @Query() q: BalanceQueryDto) {
    const result = await this.providers.balance(p.id, q.accountType, q.currency);
    if (result.kind !== 'ok')
      throw new AppError('SERVICE_UNAVAILABLE', { cause: new Error(result.reason) });
    return {
      provider: p.id,
      accountType: q.accountType,
      currency: result.currency,
      availableMinor: result.availableMinor.toString(),
    };
  }
}

@ApiTags('Providers')
@Controller('routing-rules')
export class AdminRoutingRulesController {
  constructor(private readonly rules: RoutingRulesService) {}

  @Get()
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'Routing rules by currency and priority' })
  @ApiEnvelopedResponses({ 200: rulesSchema })
  async list(@Query() q: RuleListDto) {
    return { items: (await this.rules.list(q)).map(toRule) };
  }

  @Post()
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('routing_rule.created', 'routing_rule')
  @ApiOperation({
    summary: 'Add a routing rule',
    description:
      'The provider must support the currency and be enabled; a duplicate rule is refused (`UNSAFE_CONFIGURATION`).',
  })
  @ApiEnvelopedResponses({ 201: ruleSchema })
  async create(@Body() body: CreateRuleDto, @CurrentStaff() staff: StaffPrincipal) {
    return toRule(await this.rules.create(body, staffOf(staff)));
  }

  @Get(':ref')
  @RequirePermission('ops:read')
  @ApiOperation({ summary: 'One routing rule' })
  @ApiEnvelopedResponses({ 200: ruleSchema })
  async get(@Param() p: RefDto) {
    return toRule(await this.rules.get(p.ref));
  }

  @Patch(':ref')
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('routing_rule.updated', 'routing_rule')
  @ApiOperation({
    summary: 'Change a routing rule',
    description:
      'Disabling the last enabled rule of a currency answers 202 with an approval request (give a `reason`); the currency would have no route.',
  })
  @ApiEnvelopedResponses({ 200: ruleSchema, 202: approvalRequiredSchema })
  async patch(
    @Param() p: RefDto,
    @Body() body: PatchRuleDto,
    @CurrentStaff() staff: StaffPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const result = await this.rules.update(p.ref, body, staffOf(staff));
    if (result.kind === 'applied') return toRule(result.value);
    void reply.status(202);
    return {
      approvalRequired: true as const,
      approval: toApproval({ row: result.approval, requestedByRef: staff.userRef }),
    };
  }

  @Delete(':ref')
  @HttpCode(202)
  @RequirePermission('ops:manage')
  @RequiresStepUp()
  @Audited('routing_rule.removal_requested', 'routing_rule')
  @ApiOperation({
    summary: 'Ask for a routing rule to be deleted',
    description: 'Deleting is destructive: always an approval request, never immediate.',
  })
  @ApiEnvelopedResponses({ 202: approvalRequiredSchema })
  async remove(
    @Param() p: RefDto,
    @Body() body: DeleteRuleDto,
    @CurrentStaff() staff: StaffPrincipal
  ) {
    const { approval } = await this.rules.remove(p.ref, body.reason, staffOf(staff));
    return {
      approvalRequired: true as const,
      approval: toApproval({ row: approval, requestedByRef: staff.userRef }),
    };
  }
}
