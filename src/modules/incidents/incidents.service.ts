/**
 * Incidents (spec 6.14): a lifecycle with severity, a timeline of internal and public updates,
 * affected services and merchants, a postmortem, a public status feed, and automatic opening
 * by the platform's own monitors.
 *
 * Invariants upheld, each change in one transaction with its audit row last:
 *  - An incident is deduplicated by key while it is unresolved (a unique index): a standing
 *    failure is one incident whose detection counter grows, not one per run. A resolved
 *    incident is final; a recurrence opens a new one.
 *  - Automatic incidents are never public. Only a public update (written by staff) makes an
 *    incident public, and what the status feed shows is the public updates, a coarse impact and
 *    coarse component names (`incident-rules.ts`): never the title, severity, internal services,
 *    merchants, commander, internal updates or postmortem.
 *  - Updates are append-only. A resolved incident takes no more updates, only its postmortem.
 *  - Severity changes toward sev1 notify staff; a monitor may raise severity, never lower it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import type { Executor, Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { incidentsOpened } from '../../common/telemetry/metrics';
import { CLOCK } from '../../common/tokens';
import { AmlStaffDirectory } from '../aml/aml-staff.directory';
import { NotificationsService } from '../notifications/notifications.service';
import {
  canChange,
  INCIDENT_SERVICES,
  isEscalation,
  overallStatus,
  publicComponents,
  publicImpact,
  type IncidentStatus,
  type OverallStatus,
  type PublicImpact,
  type Severity,
} from './domain/incident-rules';
import {
  IncidentsRepository,
  type IncidentRow,
  type PostmortemRow,
  type UpdateRow,
} from './incidents.repository';

export interface OpenIncidentInput {
  readonly dedupeKey: string;
  readonly title: string;
  readonly severity: Severity;
  readonly impact: string;
  readonly affectedServices: readonly string[];
  readonly source: 'reconciliation' | 'consumer' | 'monitor';
}

export interface OpenedIncident {
  readonly incident: IncidentRow;
  /** False when an unresolved incident with the dedupe key already existed. */
  readonly created: boolean;
}

export interface CreateIncidentInput {
  readonly title: string;
  readonly severity: Severity;
  readonly impact: string;
  readonly affectedServices: readonly string[];
  readonly affectedMerchantRefs?: readonly string[];
  readonly commanderRef?: string;
  readonly startedAt?: Date;
  readonly message?: string;
}

export interface UpdateIncidentInput {
  readonly title?: string;
  readonly severity?: Severity;
  readonly impact?: string;
  readonly status?: Exclude<IncidentStatus, 'resolved'>;
  readonly affectedServices?: readonly string[];
  readonly affectedMerchantRefs?: readonly string[];
  readonly commanderRef?: string | null;
  /** Only `false` is accepted: a public update is what makes an incident public. */
  readonly public?: false;
}

export interface PostmortemInput {
  readonly summary: string;
  readonly rootCause: string;
  readonly timeline: ReadonlyArray<{ at: string; event: string }>;
  readonly actionItems: ReadonlyArray<{ title: string; owner: string | null; due: string | null }>;
  readonly publish?: boolean;
}

export interface IncidentDetail {
  readonly incident: IncidentRow;
  readonly commanderRef: string | null;
  readonly merchantRefs: string[];
  readonly updates: Array<{ row: UpdateRow; authorRef: string | null }>;
  readonly postmortem: PostmortemRow | undefined;
}

export interface PublicStatusFeed {
  readonly status: OverallStatus;
  readonly updatedAt: Date;
  readonly incidents: ReadonlyArray<{
    readonly id: string;
    readonly headline: string;
    readonly status: IncidentStatus;
    readonly impact: PublicImpact;
    readonly components: string[];
    readonly startedAt: Date;
    readonly resolvedAt: Date | null;
    readonly updates: ReadonlyArray<{ status: IncidentStatus; body: string; at: Date }>;
  }>;
}

interface Staff {
  readonly userId: string;
  readonly userRef: string;
}

const PUBLIC_HISTORY_MS = 14 * 24 * 3_600_000;
const SYSTEM_ACTOR = { type: 'system' as const, id: 'monitor', label: 'incident monitors' };

@Injectable()
export class IncidentsService {
  constructor(
    private readonly incidents: IncidentsRepository,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly staffDirectory: AmlStaffDirectory,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  // -- automatic incidents -----------------------------------------------------------------

  /** Opens an incident, or counts another detection of the one already open. */
  async openAutomatic(tx: Transaction, input: OpenIncidentInput): Promise<OpenedIncident> {
    const now = this.clock.now();
    const inserted = await this.incidents.insertIfNew(tx, {
      id: uuidv7(now),
      ref: publicId('incident', now),
      title: input.title,
      severity: input.severity,
      impact: input.impact,
      affectedServices: [...input.affectedServices],
      startedAt: now,
      detectedAt: now,
      lastDetectedAt: now,
      source: input.source,
      dedupeKey: input.dedupeKey,
    });
    if (inserted) {
      await this.incidents.insertUpdate(tx, {
        id: uuidv7(now),
        incidentId: inserted.id,
        status: 'investigating',
        body: `Opened automatically: ${input.impact}`,
        public: false,
        authorId: null,
        createdAt: now,
      });
      await this.notifyOpened(tx, inserted);
      await this.audit.record(tx, {
        action: 'incident.opened',
        resourceType: 'incident',
        resourceId: inserted.ref,
        after: { severity: inserted.severity, source: inserted.source, title: inserted.title },
        actor: {
          type: 'system',
          id: input.source,
          label: input.source,
        },
      });
      incidentsOpened.inc({ severity: inserted.severity, source: inserted.source });
      return { incident: inserted, created: true };
    }
    const touched = await this.incidents.touch(tx, input.dedupeKey, now);
    if (!touched) throw new Error('incident vanished between insert and update');
    return { incident: touched, created: false };
  }

  /**
   * Raises the severity of the open incident with this key, if `severity` is worse. A monitor
   * calls it as a condition lasts longer; it never lowers a severity a person or a run set.
   */
  async raiseSeverity(
    tx: Transaction,
    dedupeKey: string,
    severity: Severity,
    reason: string
  ): Promise<IncidentRow | undefined> {
    const incident = await this.incidents.lockByDedupeKey(tx, dedupeKey);
    if (!incident || !isEscalation(incident.severity as Severity, severity)) return incident;
    const now = this.clock.now();
    const updated = await this.incidents.update(tx, incident.id, { severity });
    await this.incidents.insertUpdate(tx, {
      id: uuidv7(now),
      incidentId: incident.id,
      status: incident.status,
      body: `Severity raised from ${incident.severity} to ${severity}: ${reason}`,
      public: false,
      authorId: null,
      createdAt: now,
    });
    await this.notifications.notify(tx, {
      templateCode: 'incident.escalated',
      audience: { kind: 'staff', permission: 'ops:read' },
      resourceKey: `${incident.ref}:${severity}`,
      sourceKey: `incident.escalated:${incident.ref}:${severity}`,
      variables: { incident_ref: incident.ref, severity, title: incident.title },
    });
    await this.audit.record(tx, {
      action: 'incident.severity_raised',
      resourceType: 'incident',
      resourceId: incident.ref,
      before: { severity: incident.severity },
      after: { severity, reason },
      actor: SYSTEM_ACTOR,
    });
    return updated;
  }

  /** A monitor's condition has cleared: the open incident moves to `monitoring` for a person to resolve. */
  async noteRecovery(tx: Transaction, dedupeKey: string, body: string): Promise<boolean> {
    const incident = await this.incidents.lockByDedupeKey(tx, dedupeKey);
    if (!incident || incident.status === 'monitoring') return false;
    const now = this.clock.now();
    await this.incidents.update(tx, incident.id, { status: 'monitoring' });
    await this.incidents.insertUpdate(tx, {
      id: uuidv7(now),
      incidentId: incident.id,
      status: 'monitoring',
      body,
      public: false,
      authorId: null,
      createdAt: now,
    });
    await this.audit.record(tx, {
      action: 'incident.updated',
      resourceType: 'incident',
      resourceId: incident.ref,
      before: { status: incident.status },
      after: { status: 'monitoring' },
      actor: SYSTEM_ACTOR,
    });
    return true;
  }

  hasOpenWithPrefix(prefix: string, executor?: Executor): Promise<boolean> {
    return this.incidents.hasOpenWithPrefix(prefix, executor);
  }

  // -- staff lifecycle ---------------------------------------------------------------------

  async create(input: CreateIncidentInput, staff: Staff): Promise<IncidentDetail> {
    assertServices(input.affectedServices);
    const ref = await this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      const startedAt = input.startedAt ?? now;
      if (startedAt.getTime() > now.getTime()) {
        throw new AppError('INCIDENT_INVALID', {
          messageParams: { reason: 'started_in_future' },
          details: { reason: 'started_in_future' },
        });
      }
      const merchantIds = await this.resolveMerchants(input.affectedMerchantRefs ?? [], tx);
      const commander = input.commanderRef
        ? await this.staffDirectory.idOf(input.commanderRef)
        : null;
      const row = await this.incidents.insert(tx, {
        id: uuidv7(now),
        ref: publicId('incident', now),
        title: input.title,
        severity: input.severity,
        impact: input.impact,
        affectedServices: [...input.affectedServices],
        affectedMerchants: merchantIds,
        startedAt,
        detectedAt: now,
        lastDetectedAt: now,
        commander,
        source: 'manual',
      });
      await this.incidents.insertUpdate(tx, {
        id: uuidv7(now),
        incidentId: row.id,
        status: 'investigating',
        body: input.message ?? input.impact,
        public: false,
        authorId: staff.userId,
        createdAt: now,
      });
      await this.notifyOpened(tx, row);
      await this.audit.record(tx, {
        action: 'incident.opened',
        resourceType: 'incident',
        resourceId: row.ref,
        after: { severity: row.severity, source: 'manual', title: row.title },
      });
      incidentsOpened.inc({ severity: row.severity, source: 'manual' });
      return row.ref;
    });
    return this.get(ref);
  }

  async update(ref: string, input: UpdateIncidentInput, staff: Staff): Promise<IncidentDetail> {
    if (input.affectedServices) assertServices(input.affectedServices);
    await this.unitOfWork.run(async (tx) => {
      const incident = await this.lockOpen(tx, ref);
      const now = this.clock.now();
      const merchantIds = input.affectedMerchantRefs
        ? await this.resolveMerchants(input.affectedMerchantRefs, tx)
        : undefined;
      const commander =
        input.commanderRef === undefined
          ? undefined
          : input.commanderRef === null
            ? null
            : await this.staffDirectory.idOf(input.commanderRef);
      const updated = await this.incidents.update(tx, incident.id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
        ...(input.impact !== undefined ? { impact: input.impact } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.affectedServices ? { affectedServices: [...input.affectedServices] } : {}),
        ...(merchantIds ? { affectedMerchants: merchantIds } : {}),
        ...(commander !== undefined ? { commander } : {}),
        ...(input.public === false ? { public: false } : {}),
      });
      const raised =
        input.severity !== undefined && isEscalation(incident.severity as Severity, input.severity);
      if (raised) {
        await this.notifications.notify(tx, {
          templateCode: 'incident.escalated',
          audience: { kind: 'staff', permission: 'ops:read' },
          resourceKey: `${incident.ref}:${input.severity}`,
          sourceKey: `incident.escalated:${incident.ref}:${input.severity}`,
          variables: {
            incident_ref: incident.ref,
            severity: input.severity ?? '',
            title: updated.title,
          },
        });
      }
      if (input.status !== undefined && input.status !== incident.status) {
        await this.incidents.insertUpdate(tx, {
          id: uuidv7(now),
          incidentId: incident.id,
          status: input.status,
          body: `Status changed from ${incident.status} to ${input.status}.`,
          public: false,
          authorId: staff.userId,
          createdAt: now,
        });
      }
      await this.audit.record(tx, {
        action: 'incident.updated',
        resourceType: 'incident',
        resourceId: incident.ref,
        before: snapshot(incident),
        after: snapshot(updated),
      });
    });
    return this.get(ref);
  }

  /** A timeline entry. A public one also makes the incident public and sets its headline. */
  async addUpdate(
    ref: string,
    input: { body: string; status?: Exclude<IncidentStatus, 'resolved'>; public?: boolean },
    staff: Staff
  ): Promise<IncidentDetail> {
    await this.unitOfWork.run(async (tx) => {
      const incident = await this.lockOpen(tx, ref);
      const now = this.clock.now();
      const status = input.status ?? (incident.status as IncidentStatus);
      const makePublic = input.public === true;
      const updated = await this.incidents.update(tx, incident.id, {
        status,
        ...(makePublic ? { public: true, publicMessage: input.body } : {}),
      });
      await this.incidents.insertUpdate(tx, {
        id: uuidv7(now),
        incidentId: incident.id,
        status,
        body: input.body,
        public: makePublic,
        authorId: staff.userId,
        createdAt: now,
      });
      await this.audit.record(tx, {
        action: 'incident.update_added',
        resourceType: 'incident',
        resourceId: incident.ref,
        before: { status: incident.status, public: incident.public },
        after: { status: updated.status, public: updated.public, updatePublic: makePublic },
      });
    });
    return this.get(ref);
  }

  async resolve(
    ref: string,
    input: { body: string; public?: boolean },
    staff: Staff
  ): Promise<IncidentDetail> {
    await this.unitOfWork.run(async (tx) => {
      const incident = await this.lockOpen(tx, ref);
      const now = this.clock.now();
      const publicResolution = input.public ?? incident.public;
      const updated = await this.incidents.update(tx, incident.id, {
        status: 'resolved',
        resolvedAt: now,
        ...(publicResolution && incident.public ? { publicMessage: input.body } : {}),
      });
      await this.incidents.insertUpdate(tx, {
        id: uuidv7(now),
        incidentId: incident.id,
        status: 'resolved',
        body: input.body,
        public: publicResolution && incident.public,
        authorId: staff.userId,
        createdAt: now,
      });
      await this.audit.record(tx, {
        action: 'incident.resolved',
        resourceType: 'incident',
        resourceId: incident.ref,
        before: { status: incident.status },
        after: { status: 'resolved', resolvedAt: updated.resolvedAt?.toISOString() ?? null },
      });
    });
    return this.get(ref);
  }

  /** Creates or replaces the postmortem until it is published; publishing needs a resolved incident. */
  async writePostmortem(
    ref: string,
    input: PostmortemInput,
    staff: Staff
  ): Promise<IncidentDetail> {
    await this.unitOfWork.run(async (tx) => {
      const incident = await this.incidents.lockByRef(tx, ref);
      if (!incident) throw new AppError('NOT_FOUND');
      const now = this.clock.now();
      if (input.publish && incident.status !== 'resolved') {
        throw new AppError('INCIDENT_TRANSITION_INVALID', {
          messageParams: { reason: 'publish_needs_resolved' },
          details: { reason: 'publish_needs_resolved' },
        });
      }
      const existing = await this.incidents.lockPostmortem(tx, incident.id);
      if (existing?.publishedAt) {
        throw new AppError('INCIDENT_TRANSITION_INVALID', {
          messageParams: { reason: 'postmortem_published' },
          details: { reason: 'postmortem_published' },
        });
      }
      const values = {
        summary: input.summary,
        rootCause: input.rootCause,
        timeline: [...input.timeline],
        actionItems: [...input.actionItems],
        publishedAt: input.publish ? now : null,
      };
      if (existing) await this.incidents.updatePostmortem(tx, existing.id, values);
      else {
        await this.incidents.insertPostmortem(tx, {
          id: uuidv7(now),
          incidentId: incident.id,
          createdBy: staff.userId,
          createdAt: now,
          ...values,
        });
      }
      await this.audit.record(tx, {
        action: input.publish ? 'incident.postmortem_published' : 'incident.postmortem_saved',
        resourceType: 'incident',
        resourceId: incident.ref,
        after: { published: input.publish === true, actionItems: input.actionItems.length },
      });
    });
    return this.get(ref);
  }

  // -- reads -------------------------------------------------------------------------------

  findByRef(ref: string, executor?: Executor) {
    return this.incidents.findByRef(ref, executor);
  }

  listOpen(severity?: string, limit = 50) {
    return this.incidents.listOpen(severity, limit);
  }

  async get(ref: string): Promise<IncidentDetail> {
    const incident = await this.incidents.findByRef(ref);
    if (!incident) throw new AppError('NOT_FOUND');
    const [updates, postmortem, commanderRef, merchantRefs] = await Promise.all([
      this.incidents.updates(incident.id, { publicOnly: false }),
      this.incidents.postmortem(incident.id),
      this.incidents.commanderRef(incident.commander),
      this.incidents.merchantRefs(incident.affectedMerchants),
    ]);
    return { incident, commanderRef, merchantRefs, updates, postmortem };
  }

  async list(query: {
    status?: IncidentStatus;
    open?: boolean;
    severity?: Severity;
    source?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<{ row: IncidentRow; commanderRef: string | null }>> {
    const fingerprint = filterFingerprint({
      status: query.status,
      open: query.open,
      severity: query.severity,
      source: query.source,
    });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.incidents.list({ ...query, after });
    return toPage(rows, query.limit, fingerprint, (r) => ({
      createdAt: r.row.detectedAt,
      id: r.row.ref,
    }));
  }

  /**
   * The status page: public incidents that are open or were resolved in the last 14 days, with
   * their public updates. Two queries however many incidents there are. See the class comment
   * for what it never includes.
   */
  async publicFeed(): Promise<PublicStatusFeed> {
    const now = this.clock.now();
    const incidents = await this.incidents.publicIncidents(
      new Date(now.getTime() - PUBLIC_HISTORY_MS)
    );
    const updates = await this.incidents.publicUpdatesOf(incidents.map((i) => i.id));
    const byIncident = new Map<string, UpdateRow[]>();
    for (const u of updates) {
      const list = byIncident.get(u.incidentId) ?? [];
      list.push(u);
      byIncident.set(u.incidentId, list);
    }
    const open = incidents.filter((i) => canChange(i.status as IncidentStatus));
    return {
      status: overallStatus(open.map((i) => ({ severity: i.severity as Severity }))),
      updatedAt: now,
      incidents: incidents.map((i) => ({
        id: i.ref,
        headline: i.publicMessage ?? '',
        status: i.status as IncidentStatus,
        impact: publicImpact(i.severity as Severity),
        components: publicComponents(i.affectedServices),
        startedAt: i.startedAt,
        resolvedAt: i.resolvedAt,
        updates: (byIncident.get(i.id) ?? []).map((u) => ({
          status: u.status as IncidentStatus,
          body: u.body,
          at: u.createdAt,
        })),
      })),
    };
  }

  // -- internals ---------------------------------------------------------------------------

  private async lockOpen(tx: Transaction, ref: string): Promise<IncidentRow> {
    const incident = await this.incidents.lockByRef(tx, ref);
    if (!incident) throw new AppError('NOT_FOUND');
    if (!canChange(incident.status as IncidentStatus)) {
      throw new AppError('INCIDENT_TRANSITION_INVALID', {
        messageParams: { reason: 'incident_resolved' },
        details: { reason: 'incident_resolved' },
      });
    }
    return incident;
  }

  private async resolveMerchants(refs: readonly string[], tx: Executor): Promise<string[]> {
    const unique = [...new Set(refs)];
    const ids = await this.incidents.merchantIds(unique, tx);
    if (ids.length !== unique.length) {
      throw new AppError('INCIDENT_INVALID', {
        messageParams: { reason: 'unknown_merchant' },
        details: { reason: 'unknown_merchant' },
      });
    }
    return ids;
  }

  /** Staff are told of every sev1 and sev2, by every channel they have switched on. */
  private async notifyOpened(tx: Transaction, incident: IncidentRow): Promise<void> {
    if (incident.severity !== 'sev1' && incident.severity !== 'sev2') return;
    await this.notifications.notify(tx, {
      templateCode: 'incident.opened',
      audience: { kind: 'staff', permission: 'ops:read' },
      resourceKey: incident.ref,
      sourceKey: `incident.opened:${incident.ref}`,
      variables: { incident_ref: incident.ref, severity: incident.severity, title: incident.title },
    });
  }
}

function assertServices(services: readonly string[]): void {
  const unknown = services.filter((s) => !(INCIDENT_SERVICES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new AppError('INCIDENT_INVALID', {
      messageParams: { reason: 'unknown_service' },
      details: { reason: 'unknown_service', services: unknown },
    });
  }
}

function snapshot(row: IncidentRow): Record<string, unknown> {
  return {
    title: row.title,
    severity: row.severity,
    status: row.status,
    services: row.affectedServices,
    merchants: row.affectedMerchants.length,
    public: row.public,
  };
}
