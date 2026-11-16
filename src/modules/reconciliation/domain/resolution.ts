/**
 * Which accounts a write-off may clear (spec 6.8: "written off to 5100:loss_writeoff"). Pure.
 *
 * A write-off debits `5100:loss_writeoff` and credits the account that holds the unexplained
 * amount. Only platform asset accounts qualify: provider clearing, provider float, bank and
 * suspense. A merchant's payable or reserve is what the platform owes the merchant, and a
 * reconciliation write-off must never reduce it.
 */
import { parseAccountCode, type AccountPurpose } from '../../accounts/domain/chart-of-accounts';

const WRITE_OFF_SOURCES: readonly AccountPurpose[] = [
  'provider_clearing',
  'provider_float',
  'bank',
  'suspense',
];

export function isWriteOffSource(accountCode: string): boolean {
  const parsed = parseAccountCode(accountCode);
  return parsed !== undefined && WRITE_OFF_SOURCES.includes(parsed.purpose);
}

export const LOSS_WRITEOFF_ACCOUNT = '5100:loss_writeoff';
