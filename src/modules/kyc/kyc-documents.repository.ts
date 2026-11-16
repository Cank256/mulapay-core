/** SQL for `core.kyc_documents`. Merchant-facing lookups take the merchant id (spec 8.4). */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../../common/db/database.types';
import { DB_RW } from '../../common/db/tokens';
import { kycDocuments } from '../../db/schema';

export type DocumentRow = typeof kycDocuments.$inferSelect;
export type NewDocument = typeof kycDocuments.$inferInsert;

@Injectable()
export class KycDocumentsRepository {
  constructor(@Inject(DB_RW) private readonly db: Executor) {}

  async insert(tx: Executor, values: NewDocument): Promise<DocumentRow | null> {
    const [row] = await tx.insert(kycDocuments).values(values).onConflictDoNothing().returning();
    return row ?? null;
  }

  async findByFileKey(fileKey: string, tx: Executor = this.db): Promise<DocumentRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycDocuments)
      .where(eq(kycDocuments.fileKey, fileKey))
      .limit(1);
    return row;
  }

  /** A document of this merchant, by its public ref. Another merchant's ref is "not found". */
  async findForMerchant(
    merchantId: string,
    ref: string,
    tx: Executor = this.db
  ): Promise<DocumentRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycDocuments)
      .where(and(eq(kycDocuments.merchantId, merchantId), eq(kycDocuments.ref, ref)))
      .limit(1);
    return row;
  }

  async lockForMerchant(
    tx: Executor,
    merchantId: string,
    ref: string
  ): Promise<DocumentRow | undefined> {
    const [row] = await tx
      .select()
      .from(kycDocuments)
      .where(and(eq(kycDocuments.merchantId, merchantId), eq(kycDocuments.ref, ref)))
      .for('update');
    return row;
  }

  /** The documents of a merchant that have not been removed, oldest first. */
  listActive(merchantId: string, tx: Executor = this.db): Promise<DocumentRow[]> {
    return tx
      .select()
      .from(kycDocuments)
      .where(and(eq(kycDocuments.merchantId, merchantId), isNull(kycDocuments.removedAt)))
      .orderBy(asc(kycDocuments.uploadedAt), asc(kycDocuments.ref));
  }

  async review(
    tx: Executor,
    id: string,
    values: {
      status: 'verified' | 'rejected';
      verifiedBy: string;
      verifiedAt: Date;
      rejectionReason?: string;
      rejectionNote?: string;
      expiresAt?: Date | null;
    }
  ): Promise<DocumentRow> {
    const [row] = await tx
      .update(kycDocuments)
      .set({
        status: values.status,
        verifiedBy: values.verifiedBy,
        verifiedAt: values.verifiedAt,
        rejectionReason: values.rejectionReason ?? null,
        rejectionNote: values.rejectionNote ?? null,
        ...(values.expiresAt !== undefined ? { expiresAt: values.expiresAt } : {}),
      })
      .where(eq(kycDocuments.id, id))
      .returning();
    if (!row) throw new Error('document update returned no row');
    return row;
  }

  async markRemoved(tx: Executor, id: string, at: Date): Promise<DocumentRow> {
    const [row] = await tx
      .update(kycDocuments)
      .set({ removedAt: at })
      .where(eq(kycDocuments.id, id))
      .returning();
    if (!row) throw new Error('document removal returned no row');
    return row;
  }
}
