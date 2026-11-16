/**
 * Opens incidents on behalf of the platform (spec 6.8: a ledger integrity failure opens a
 * sev1 automatically). `openAutomatic` runs in the caller's transaction and is idempotent
 * on its dedupe key: while an incident for that key is unresolved, a repeat detection only
 * bumps its counter, so an hourly run does not page every hour for one standing failure.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../common/clock/clock';
import type { Executor } from '../../common/db/database.types';
import { AuditService } from '../../common/audit/audit.service';
import type { Transaction } from '../../common/db/database.types';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { IncidentsRepository, type IncidentRow } from './incidents.repository';

export interface OpenIncidentInput {
  readonly dedupeKey: string;
  readonly title: string;
  readonly severity: 'sev1' | 'sev2' | 'sev3' | 'sev4';
  readonly impact: string;
  readonly affectedServices: readonly string[];
  readonly source: 'reconciliation' | 'consumer';
}

export interface OpenedIncident {
  readonly incident: IncidentRow;
  /** False when an unresolved incident with the dedupe key already existed. */
  readonly created: boolean;
}

@Injectable()
export class IncidentsService {
  constructor(
    private readonly incidents: IncidentsRepository,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

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
      await this.audit.record(tx, {
        action: 'incident.opened',
        resourceType: 'incident',
        resourceId: inserted.ref,
        after: { severity: inserted.severity, source: inserted.source, title: inserted.title },
        actor: { type: 'system', id: 'reconciliation', label: 'reconciliation' },
      });
      return { incident: inserted, created: true };
    }
    const touched = await this.incidents.touch(tx, input.dedupeKey, now);
    if (!touched) throw new Error('incident vanished between insert and update');
    return { incident: touched, created: false };
  }

  findByRef(ref: string, executor?: Executor) {
    return this.incidents.findByRef(ref, executor);
  }

  listOpen(severity?: string, limit = 50) {
    return this.incidents.listOpen(severity, limit);
  }
}
