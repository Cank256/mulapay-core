/** `/dashboard/v1/team` (spec 7.2): members and invitations of the caller's merchant. */
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { MERCHANT_ROLES } from '../../common/authz/permissions';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { InvitationsService } from '../../modules/merchants/invitations.service';
import {
  createdInvitationSchema,
  invitationSchema,
  memberSchema,
} from '../../modules/merchants/merchant.views';
import { TeamService } from '../../modules/merchants/team.service';
import { okSchema } from '../shared/auth.views';
import { emailSchema, idParamSchema, refSchema } from '../shared/schemas';

const INVITABLE_ROLES = ['admin', 'developer', 'finance', 'support', 'viewer'] as const;

class InviteDto extends createZodDto(
  z.strictObject({ email: emailSchema, role: z.enum(INVITABLE_ROLES) })
) {}
class InviteParamDto extends createZodDto(idParamSchema) {}
class MemberParamDto extends createZodDto(z.strictObject({ userId: refSchema })) {}
/** `owner` here means "transfer ownership to this member" and is owner-only. */
class ChangeRoleDto extends createZodDto(z.strictObject({ role: z.enum(MERCHANT_ROLES) })) {}

function actorOf(principal: MerchantUserPrincipal) {
  return { userId: principal.userId, userRef: principal.userRef, role: principal.role };
}

@ApiTags('Team')
@Controller('team')
export class DashboardTeamController {
  constructor(
    private readonly team: TeamService,
    private readonly invitations: InvitationsService
  ) {}

  @Get()
  @RequirePermission('team:read')
  @ApiOperation({ summary: 'Active team members' })
  @ApiEnvelopedResponses({ 200: z.array(memberSchema) })
  list(@CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return this.team.list(principal.merchant.id);
  }

  @Post('invites')
  @RequirePermission('team:manage')
  @Audited('invitation.created', 'invitation')
  @ApiOperation({ summary: 'Invite a member. The response carries the invitation token once' })
  @ApiEnvelopedResponses({ 201: createdInvitationSchema })
  invite(@Body() body: InviteDto, @CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return this.invitations.create(principal.merchant.id, body, actorOf(principal));
  }

  @Get('invites')
  @RequirePermission('team:read')
  @ApiOperation({ summary: 'Pending invitations' })
  @ApiEnvelopedResponses({ 200: z.array(invitationSchema) })
  listInvites(@CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return this.invitations.listPending(principal.merchant.id);
  }

  @Delete('invites/:id')
  @RequirePermission('team:manage')
  @Audited('invitation.revoked', 'invitation')
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async revokeInvite(
    @Param() params: InviteParamDto,
    @CurrentMerchantUser() principal: MerchantUserPrincipal
  ) {
    await this.invitations.revoke(principal.merchant.id, params.id);
    return { ok: true as const };
  }

  @Patch(':userId')
  @RequirePermission('team:manage')
  @Audited('merchant_member.role_changed', 'merchant_member')
  @ApiOperation({
    summary: 'Change a member’s role; role "owner" transfers ownership (owner only)',
  })
  @ApiEnvelopedResponses({ 200: memberSchema })
  changeRole(
    @Param() params: MemberParamDto,
    @Body() body: ChangeRoleDto,
    @CurrentMerchantUser() principal: MerchantUserPrincipal
  ) {
    return this.team.changeRole(
      principal.merchant.id,
      actorOf(principal),
      params.userId,
      body.role
    );
  }

  @Delete(':userId')
  @RequirePermission('team:manage')
  @Audited('merchant_member.removed', 'merchant_member')
  @ApiOperation({ summary: 'Remove a member. The owner cannot be removed' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async remove(
    @Param() params: MemberParamDto,
    @CurrentMerchantUser() principal: MerchantUserPrincipal
  ) {
    await this.team.remove(principal.merchant.id, params.userId);
    return { ok: true as const };
  }
}
