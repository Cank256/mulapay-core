/**
 * Provider statement upload (spec 6.8 run 3, 7.3 `POST /admin/v1/reconciliation/statements`).
 *
 * The statement and every row are stored in one transaction with an outbox message that
 * queues the matching job, so a statement is either fully stored and queued, or absent.
 * The same statement cannot be stored twice: a hash of its canonical content is unique per
 * provider and currency, so a double click or a retried upload answers 409.
 *
 * Rows arrive in the request body (`rows`, at most 2,000). The presigned-upload flow of the
 * spec needs the object-storage integration, which is not built; `file_key` is reserved.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { sha256Hex } from '../../common/crypto/crypto';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { OutboxService } from '../../common/outbox/outbox.service';
import { decodeCursor, filterFingerprint, toPage, type Page } from '../../common/pagination/cursor';
import { isSupportedCurrency } from '../../common/money/currency-codes';
import { CLOCK } from '../../common/tokens';
import { providerSupportsCurrency } from '../../integrations/gateway/provider-capabilities';
import { isPaymentProvider } from '../payments/domain/payment-event';
import {
  StatementsRepository,
  type StatementLineRow,
  type StatementRow,
} from './statements.repository';

export const STATEMENT_UPLOADED_OUTBOX_TYPE = 'reconciliation.statement_uploaded';
export const MAX_STATEMENT_ROWS = 2000;

export interface StatementRowUpload {
  readonly providerRef: string;
  /** Minor units, a digit string. */
  readonly amountMinor: string;
  readonly occurredAt: Date;
  readonly raw?: Record<string, string>;
}

export interface StatementUpload {
  readonly provider: string;
  readonly currency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly rows: readonly StatementRowUpload[];
}

function invalid(reason: string): AppError {
  return new AppError('RECONCILIATION_STATEMENT_INVALID', {
    messageParams: { reason },
    details: { reason },
  });
}

@Injectable()
export class StatementsService {
  constructor(
    private readonly statements: StatementsRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  /** Stores a statement and queues its matching. Upholds: one stored copy per content. */
  async upload(input: StatementUpload, uploadedBy: string): Promise<StatementRow> {
    const rows = this.validate(input);
    const canonical = rows.map(
      (r) => `${r.providerRef}|${r.amountMinor}|${r.occurredAt.toISOString()}`
    );
    const contentSha256 = sha256Hex(
      [
        input.provider,
        input.currency,
        input.periodStart.toISOString(),
        input.periodEnd.toISOString(),
        ...[...canonical].sort(),
      ].join('\n')
    );
    const now = this.clock.now();
    return this.unitOfWork.run(async (tx) => {
      const duplicate = await this.statements.findByContent(
        tx,
        input.provider,
        input.currency,
        contentSha256
      );
      if (duplicate) {
        throw new AppError('RECONCILIATION_STATEMENT_DUPLICATE', {
          details: { statement: duplicate.ref },
        });
      }
      const statement = await this.statements.insert(tx, {
        id: uuidv7(now),
        ref: publicId('providerStatement', now),
        provider: input.provider,
        currency: input.currency,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        contentSha256,
        rowCount: rows.length,
        totalMinor: rows.reduce((sum, r) => sum + r.amountMinor, 0n),
        uploadedBy,
        createdAt: now,
      });
      await this.statements.insertLines(
        tx,
        rows.map((row, index) => ({
          id: uuidv7(now),
          statementId: statement.id,
          rowNo: index + 1,
          providerRef: row.providerRef,
          amountMinor: row.amountMinor,
          currency: input.currency,
          occurredAt: row.occurredAt,
          raw: row.raw ?? {},
          createdAt: now,
        }))
      );
      await this.outbox.enqueue(tx, {
        eventType: STATEMENT_UPLOADED_OUTBOX_TYPE,
        aggregateType: 'provider_statement',
        aggregateId: statement.id,
        payload: { statementId: statement.id, statementRef: statement.ref },
        dedupeKey: `statement-uploaded:${statement.id}`,
      });
      await this.audit.record(tx, {
        action: 'reconciliation.statement.uploaded',
        resourceType: 'provider_statement',
        resourceId: statement.ref,
        after: {
          provider: statement.provider,
          currency: statement.currency,
          rows: statement.rowCount,
          totalMinor: statement.totalMinor,
        },
      });
      return statement;
    });
  }

  findByRef(ref: string) {
    return this.statements.findByRef(ref);
  }

  async list(query: {
    provider?: string;
    limit: number;
    cursor?: string;
  }): Promise<Page<StatementRow>> {
    const fingerprint = filterFingerprint({ provider: query.provider });
    const after = query.cursor ? decodeCursor(query.cursor, fingerprint) : undefined;
    const rows = await this.statements.list({
      provider: query.provider,
      after,
      limit: query.limit,
    });
    return toPage(rows, query.limit, fingerprint, (r) => ({ createdAt: r.createdAt, id: r.ref }));
  }

  /** Rows in row order, `limit` at a time after `afterRowNo`. */
  async rows(
    statementRef: string,
    afterRowNo: number,
    limit: number
  ): Promise<{ items: StatementLineRow[]; nextAfterRowNo: number | null }> {
    const statement = await this.statements.findByRef(statementRef);
    if (!statement) throw new AppError('NOT_FOUND');
    const page = await this.statements.pageOfLines(statement.id, afterRowNo, limit);
    const items = page.slice(0, limit);
    const last = items.at(-1);
    return { items, nextAfterRowNo: page.length > limit && last ? last.rowNo : null };
  }

  private validate(input: StatementUpload): {
    providerRef: string;
    amountMinor: bigint;
    occurredAt: Date;
    raw?: Record<string, string>;
  }[] {
    if (!isPaymentProvider(input.provider)) throw invalid('provider');
    if (
      !isSupportedCurrency(input.currency) ||
      !providerSupportsCurrency(input.provider, input.currency)
    ) {
      throw invalid('currency');
    }
    if (input.periodEnd <= input.periodStart) throw invalid('period');
    if (input.rows.length < 1 || input.rows.length > MAX_STATEMENT_ROWS) throw invalid('row_count');
    return input.rows.map((row, index) => {
      if (!/^[0-9]{1,18}$/.test(row.amountMinor)) throw invalid(`row_${index + 1}_amount`);
      const amountMinor = BigInt(row.amountMinor);
      if (amountMinor <= 0n) throw invalid(`row_${index + 1}_amount`);
      if (row.providerRef.length < 1 || row.providerRef.length > 128) {
        throw invalid(`row_${index + 1}_reference`);
      }
      if (row.occurredAt < input.periodStart || row.occurredAt >= input.periodEnd) {
        throw invalid(`row_${index + 1}_outside_period`);
      }
      return {
        providerRef: row.providerRef,
        amountMinor,
        occurredAt: row.occurredAt,
        raw: row.raw,
      };
    });
  }
}
