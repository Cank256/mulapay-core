/**
 * What an incident looks like on the admin API, and what the public status feed shows (spec
 * 6.14). The public feed has its own, much smaller shape: see `incident-rules.ts` for what it
 * leaves out, and the test that proves nothing internal appears in it.
 */
import { z } from 'zod';
import { INCIDENT_STATUSES, SEVERITIES } from './domain/incident-rules';
import type { IncidentDetail, PublicStatusFeed } from './incidents.service';
import type { IncidentRow } from './incidents.repository';

const iso = z.string();

export const incidentUpdateSchema = z.object({
  id: z.string(),
  status: z.enum(INCIDENT_STATUSES),
  body: z.string(),
  public: z.boolean(),
  author: z.string().nullable(),
  createdAt: iso,
});

export const incidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  impact: z.string(),
  affectedServices: z.array(z.string()),
  affectedMerchants: z.array(z.string()),
  commander: z.string().nullable(),
  source: z.enum(['manual', 'reconciliation', 'consumer', 'monitor']),
  public: z.boolean(),
  publicMessage: z.string().nullable(),
  detectionCount: z.number().int(),
  startedAt: iso,
  detectedAt: iso,
  lastDetectedAt: iso,
  resolvedAt: iso.nullable(),
});

export const postmortemSchema = z.object({
  summary: z.string(),
  rootCause: z.string(),
  timeline: z.array(z.object({ at: z.string(), event: z.string() })),
  actionItems: z.array(
    z.object({ title: z.string(), owner: z.string().nullable(), due: z.string().nullable() })
  ),
  publishedAt: iso.nullable(),
  updatedAt: iso,
});

export const incidentDetailSchema = incidentSchema.extend({
  updates: z.array(incidentUpdateSchema),
  postmortem: postmortemSchema.nullable(),
});

export const incidentPageSchema = z.object({
  items: z.array(incidentSchema),
  nextCursor: z.string().nullable(),
});

export function toIncident(
  row: IncidentRow,
  extras: { commanderRef: string | null; merchantRefs: string[] }
): z.infer<typeof incidentSchema> {
  return {
    id: row.ref,
    title: row.title,
    severity: row.severity as z.infer<typeof incidentSchema>['severity'],
    status: row.status as z.infer<typeof incidentSchema>['status'],
    impact: row.impact,
    affectedServices: row.affectedServices,
    affectedMerchants: extras.merchantRefs,
    commander: extras.commanderRef,
    source: row.source as z.infer<typeof incidentSchema>['source'],
    public: row.public,
    publicMessage: row.publicMessage,
    detectionCount: row.detectionCount,
    startedAt: row.startedAt.toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    lastDetectedAt: row.lastDetectedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export function toIncidentDetail(detail: IncidentDetail): z.infer<typeof incidentDetailSchema> {
  const pm = detail.postmortem;
  return {
    ...toIncident(detail.incident, detail),
    updates: detail.updates.map((u) => ({
      id: u.row.id,
      status: u.row.status as z.infer<typeof incidentUpdateSchema>['status'],
      body: u.row.body,
      public: u.row.public,
      author: u.authorRef,
      createdAt: u.row.createdAt.toISOString(),
    })),
    postmortem: pm
      ? {
          summary: pm.summary,
          rootCause: pm.rootCause,
          timeline: pm.timeline,
          actionItems: pm.actionItems,
          publishedAt: pm.publishedAt?.toISOString() ?? null,
          updatedAt: pm.updatedAt.toISOString(),
        }
      : null,
  };
}

/** The public status feed (`GET /v1/status`, `GET /dashboard/v1/status`). No auth, no internals. */
export const publicStatusSchema = z.object({
  status: z.enum(['operational', 'degraded', 'major_outage']),
  updatedAt: iso,
  incidents: z.array(
    z.object({
      id: z.string(),
      headline: z.string(),
      status: z.enum(INCIDENT_STATUSES),
      impact: z.enum(['minor', 'major']),
      components: z.array(z.string()),
      startedAt: iso,
      resolvedAt: iso.nullable(),
      updates: z.array(z.object({ status: z.enum(INCIDENT_STATUSES), body: z.string(), at: iso })),
    })
  ),
});

export function toPublicStatus(feed: PublicStatusFeed): z.infer<typeof publicStatusSchema> {
  return {
    status: feed.status,
    updatedAt: feed.updatedAt.toISOString(),
    incidents: feed.incidents.map((i) => ({
      id: i.id,
      headline: i.headline,
      status: i.status,
      impact: i.impact,
      components: i.components,
      startedAt: i.startedAt.toISOString(),
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      updates: i.updates.map((u) => ({ status: u.status, body: u.body, at: u.at.toISOString() })),
    })),
  };
}
