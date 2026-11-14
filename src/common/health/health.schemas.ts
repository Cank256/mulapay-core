import { z } from 'zod';

/** Liveness: the process is up. Matches the gateway's `{ status: 'ok' }`. */
export const livenessSchema = z.object({ status: z.literal('ok') });
export type Liveness = z.infer<typeof livenessSchema>;

/**
 * Readiness: dependencies are reachable. Like the gateway, the body carries only the
 * status; which dependency failed is logged, not exposed on an unauthenticated route.
 */
export const readinessSchema = z.object({ status: z.enum(['ready', 'not_ready']) });
export type Readiness = z.infer<typeof readinessSchema>;
