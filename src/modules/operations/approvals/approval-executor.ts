import type { Transaction } from '../../../common/db/database.types';
import type { ApprovalRow } from './approvals.repository';

export const APPROVAL_EXECUTORS = Symbol('APPROVAL_EXECUTORS');

export interface ApprovalContext {
  readonly approver: { readonly userId: string; readonly userRef: string };
  readonly now: Date;
}

/**
 * What an approval kind does. `prepare` runs when the request is made: it validates and
 * normalises the payload, so a request that could never be carried out is refused at once.
 * `execute` runs inside the approving transaction, so the change and the decision commit
 * together; it checks again that the change is still valid, because the world may have moved
 * since the request. It writes its own audit row.
 */
export interface ApprovalExecutor {
  readonly kind: string;
  prepare(
    tx: Transaction,
    payload: Readonly<Record<string, unknown>>
  ): Promise<Record<string, unknown>>;
  execute(
    tx: Transaction,
    approval: ApprovalRow,
    ctx: ApprovalContext
  ): Promise<Record<string, unknown>>;
}
