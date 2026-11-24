import type { Routes } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { HealthModule } from '../common/health/health.module';
import { AdminSurfaceModule } from './admin/admin-surface.module';
import { DashboardSurfaceModule } from './dashboard/dashboard-surface.module';
import { PublicSurfaceModule } from './public/public-surface.module';

export type SurfaceKey = 'public' | 'dashboard' | 'admin';

export interface SurfaceDefinition {
  readonly key: SurfaceKey;
  readonly prefix: string;
  readonly title: string;
  readonly description: string;
  /** Modules whose controllers appear in this surface's OpenAPI document. */
  readonly documentModules: readonly Type[];
}

export const SURFACES: readonly SurfaceDefinition[] = [
  {
    key: 'public',
    prefix: 'v1',
    title: 'MulaPay API',
    description:
      'Server-to-server merchant API. Browser origins are not allowed. Includes the unauthenticated health probes.',
    documentModules: [PublicSurfaceModule, HealthModule],
  },
  {
    key: 'dashboard',
    prefix: 'merchant/v1',
    title: 'MulaPay Dashboard API',
    description: 'API for the merchant dashboard web application.',
    documentModules: [DashboardSurfaceModule],
  },
  {
    key: 'admin',
    prefix: 'admin/v1',
    title: 'MulaPay Admin API',
    description: 'API for the MulaPay admin console. Staff only, MFA required.',
    documentModules: [AdminSurfaceModule],
  },
];

export const SURFACE_MODULES = [PublicSurfaceModule, DashboardSurfaceModule, AdminSurfaceModule];

export const SURFACE_ROUTES: Routes = [
  { path: 'v1', module: PublicSurfaceModule },
  { path: 'merchant/v1', module: DashboardSurfaceModule },
  { path: 'admin/v1', module: AdminSurfaceModule },
];
