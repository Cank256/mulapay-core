/**
 * `@Audited(action, resourceType)` names the audit action of a state-changing route.
 * Every POST, PATCH, PUT and DELETE route carries it (asserted by a test). The service
 * writes the success row with before and after; the guard and the interceptor use this
 * metadata for denied and failed requests, and as a backstop when no row was written.
 */
import { SetMetadata } from '@nestjs/common';

export const AUDITED = Symbol('AUDITED');

export interface AuditedMetadata {
  readonly action: string;
  readonly resourceType: string;
}

export const Audited = (action: string, resourceType: string) =>
  SetMetadata(AUDITED, { action, resourceType } satisfies AuditedMetadata);
