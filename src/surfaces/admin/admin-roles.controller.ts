/** `/admin/v1/roles` (spec 7.3 "roles + permission editing"). Edits need step-up. */
import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Audited } from '../../common/audit/audited.decorator';
import { RequirePermission, RequiresStepUp } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { RolesService } from '../../modules/identity/roles.service';

const roleSchema = z.object({
  key: z.string(),
  actorType: z.enum(['staff', 'merchant']),
  description: z.string(),
  permissions: z.array(z.string()),
});
const rolesSchema = z.object({
  roles: z.array(roleSchema),
  permissions: z.array(
    z.object({ key: z.string(), actorType: z.string(), description: z.string() })
  ),
});

class RoleParamDto extends createZodDto(
  z.strictObject({ key: z.string().regex(/^[a-z_]{1,40}$/) })
) {}
class SetPermissionsDto extends createZodDto(
  z.strictObject({ permissions: z.array(z.string().regex(/^[a-z_]+:[a-z_]+$/)).max(100) })
) {}

@ApiTags('Roles')
@Controller('roles')
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission('roles:read')
  @ApiOperation({ summary: 'Roles with their permissions, and every permission that exists' })
  @ApiEnvelopedResponses({ 200: rolesSchema })
  list() {
    return this.roles.list();
  }

  @Patch(':key')
  @RequirePermission('roles:manage')
  @RequiresStepUp()
  @Audited('role.permissions_updated', 'role')
  @ApiOperation({ summary: 'Replace the permissions of a role' })
  @ApiEnvelopedResponses({ 200: roleSchema })
  setPermissions(@Param() params: RoleParamDto, @Body() body: SetPermissionsDto) {
    return this.roles.setPermissions(params.key, body.permissions);
  }
}
