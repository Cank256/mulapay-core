/**
 * Writes audit rows (spec section 6.14).
 *
 * Invariant: a state change and its audit row commit together. Application services call
 * `record(tx, ...)` inside the same UnitOfWork as the change, as the last statement so
 * the chain-head lock is held briefly. Denied and failed requests, which have no business
 * transaction, are written by `recordStandalone` from the guard and the interceptor.
 *
 * Actor, IP, user agent, request id, trace id and surface come from the request context
 * unless the entry overrides the actor (for example a login, where the actor is the user
 * being authenticated).
 */
import { Inject, Injectable } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Clock } from '../clock/clock';
import { requestContext, type ActorType } from '../context/request-context';
import type { Transaction } from '../db/database.types';
import { UnitOfWork } from '../db/unit-of-work';
import { CLOCK } from '../tokens';
import { changedFields, chainHash, toJsonValue, type ChainedFields } from './audit-chain';
import { AuditRepository } from './audit.repository';

export type AuditOutcome = 'success' | 'denied' | 'error';

export interface AuditActor {
  readonly type: ActorType;
  readonly id: string | null;
  readonly label: string | null;
}

export interface AuditEntry {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  /** Internal merchant UUID the action concerns, when there is one. */
  readonly merchantId?: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly outcome?: AuditOutcome;
  readonly actor?: AuditActor;
}

function activeTraceId(): string | null {
  const span = trace.getActiveSpan()?.spanContext();
  return span && isSpanContextValid(span) ? span.traceId : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const json = toJsonValue(value);
  return json !== undefined && json !== null && typeof json === 'object' && !Array.isArray(json)
    ? json
    : null;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Appends one row inside the caller's transaction. Returns its seq. */
  async record(tx: Transaction, entry: AuditEntry): Promise<number> {
    const ctx = requestContext.get();
    const actor: AuditActor = entry.actor ?? {
      type: ctx?.actorType ?? 'system',
      id: ctx?.actorId ?? null,
      label: ctx?.actorLabel ?? null,
    };
    const before = asRecord(entry.before);
    const after = asRecord(entry.after);
    const head = await this.repository.lockHead(tx);
    const fields: ChainedFields = {
      seq: head.lastSeq + 1,
      actorType: actor.type,
      actorId: actor.id,
      actorLabel: actor.label,
      merchantId: entry.merchantId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      before,
      after,
      changedFields: changedFields(before, after),
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      requestId: ctx?.requestId ?? null,
      traceId: activeTraceId(),
      surface: ctx?.surface ?? null,
      outcome: entry.outcome ?? 'success',
      createdAt: this.clock.now(),
    };
    const hash = chainHash(head.lastHash, fields);
    await this.repository.append(tx, { ...fields, prevHash: head.lastHash, hash });
    if (ctx) ctx.auditRows = (ctx.auditRows ?? 0) + 1;
    return fields.seq;
  }

  /** Appends one row in its own transaction. */
  recordStandalone(entry: AuditEntry): Promise<number> {
    return this.unitOfWork.run((tx) => this.record(tx, entry));
  }
}
