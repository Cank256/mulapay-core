/**
 * `/admin/v1` surface (spec section 4.2): the admin console, authenticated by JWT plus MFA, staff-scoped (Phase 1).
 *
 * Controllers for this surface live in this module tree only, with this surface's guards,
 * so a controller here can never serve another surface's routes. Domain services are
 * shared; controllers are not. Phase 0 registers no routes.
 */
import { Module } from '@nestjs/common';

@Module({})
export class AdminSurfaceModule {}
