/** What reports and schedules look like on the API (spec 7.2, 7.3). File keys are never shown. */
import { z } from 'zod';
import { REPORT_FORMATS, REPORT_STATUSES, REPORT_TYPES } from '../../db/schema';
import type { ReportWithRefs, RunRow, ScheduleRow } from './reports.repository';

const iso = z.string();

export const reportSchema = z.object({
  id: z.string(),
  type: z.enum(REPORT_TYPES),
  format: z.enum(REPORT_FORMATS),
  status: z.enum(REPORT_STATUSES),
  params: z.record(z.string(), z.unknown()),
  rowCount: z.number().int().nullable(),
  fileSize: z.number().int().nullable(),
  sha256: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: iso,
  finishedAt: iso.nullable(),
  expiresAt: iso.nullable(),
});
export const adminReportSchema = reportSchema.extend({ merchant: z.string().nullable() });
export const reportPageSchema = z.object({
  items: z.array(reportSchema),
  nextCursor: z.string().nullable(),
});
export const adminReportPageSchema = z.object({
  items: z.array(adminReportSchema),
  nextCursor: z.string().nullable(),
});
export const downloadSchema = z.object({ url: z.string(), expiresAt: iso, filename: z.string() });

export const scheduleSchema = z.object({
  id: z.string(),
  reportType: z.enum(REPORT_TYPES),
  params: z.record(z.string(), z.unknown()),
  period: z.enum(['previous_day', 'previous_week', 'previous_month']),
  cron: z.string(),
  timezone: z.string(),
  recipients: z.array(z.string()),
  format: z.enum(REPORT_FORMATS),
  active: z.boolean(),
  lastRunAt: iso.nullable(),
  nextRunAt: iso,
  lastStatus: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  disabledReason: z.string().nullable(),
  createdAt: iso,
});
export const scheduleRunSchema = z.object({
  dueAt: iso,
  status: z.enum(['queued', 'succeeded', 'failed', 'skipped']),
  error: z.string().nullable(),
  startedAt: iso,
  finishedAt: iso.nullable(),
});
export const scheduleDetailSchema = scheduleSchema.extend({ history: z.array(scheduleRunSchema) });
export const schedulePageSchema = z.object({
  items: z.array(scheduleSchema),
  nextCursor: z.string().nullable(),
});

export function toReport(found: ReportWithRefs): z.infer<typeof reportSchema> {
  const { row } = found;
  return {
    id: row.ref,
    type: row.type as z.infer<typeof reportSchema>['type'],
    format: row.format as z.infer<typeof reportSchema>['format'],
    status: row.status as z.infer<typeof reportSchema>['status'],
    params: row.params,
    rowCount: row.rowCount,
    fileSize: row.fileSize,
    sha256: row.sha256,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

export const toAdminReport = (found: ReportWithRefs): z.infer<typeof adminReportSchema> => ({
  ...toReport(found),
  merchant: found.merchantRef,
});

export function toSchedule(row: ScheduleRow): z.infer<typeof scheduleSchema> {
  return {
    id: row.ref,
    reportType: row.reportType as z.infer<typeof scheduleSchema>['reportType'],
    params: row.params,
    period: row.period as z.infer<typeof scheduleSchema>['period'],
    cron: row.cron,
    timezone: row.timezone,
    recipients: row.recipients,
    format: row.format as z.infer<typeof scheduleSchema>['format'],
    active: row.active,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    lastStatus: row.lastStatus,
    consecutiveFailures: row.consecutiveFailures,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt.toISOString(),
  };
}

export const toScheduleDetail = (row: ScheduleRow, history: RunRow[]) => ({
  ...toSchedule(row),
  history: history.map((h) => ({
    dueAt: h.dueAt.toISOString(),
    status: h.status as 'queued' | 'succeeded' | 'failed' | 'skipped',
    error: h.error,
    startedAt: h.startedAt.toISOString(),
    finishedAt: h.finishedAt?.toISOString() ?? null,
  })),
});
