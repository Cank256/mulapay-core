/**
 * SQL for appending to the audit chain. Reads for the admin API live in
 * src/modules/audit.
 */
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { auditChainHead, auditLogs } from '../../db/schema';
import type { Transaction } from '../db/database.types';
import type { ChainCursor, ChainedFields } from './audit-chain';

@Injectable()
export class AuditRepository {
  /**
   * Locks the chain head row until the transaction ends. Every append takes this lock, so
   * appends are serialised in commit order and each sees the previous committed hash.
   */
  async lockHead(tx: Transaction): Promise<ChainCursor> {
    const [head] = await tx
      .select({ lastSeq: auditChainHead.lastSeq, lastHash: auditChainHead.lastHash })
      .from(auditChainHead)
      .where(eq(auditChainHead.id, 1))
      .for('update');
    if (!head) throw new Error('core.audit_chain_head is missing; migration 0001 seeds it');
    return head;
  }

  async append(tx: Transaction, row: ChainedFields & { prevHash: string; hash: string }) {
    await tx.insert(auditLogs).values({ ...row, changedFields: [...row.changedFields] });
    await tx
      .update(auditChainHead)
      .set({ lastSeq: row.seq, lastHash: row.hash })
      .where(eq(auditChainHead.id, 1));
  }
}
