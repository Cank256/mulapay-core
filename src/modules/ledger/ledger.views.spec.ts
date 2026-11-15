import { describe, expect, it } from 'vitest';
import { toIntegrityView } from './ledger.views';
import type { LedgerIntegrityReport } from './ledger-integrity.service';
describe('toIntegrityView', () => {
  it('renders every bigint as a decimal string', () => {
    const at = new Date('2025-01-01T00:00:00Z');
    const report: LedgerIntegrityReport = {
      ok: false,
      checkedAt: at,
      window: { from: at, to: at },
      invalidEntries: [
        {
          entryRef: 'je_1',
          createdAt: 'x',
          reasons: ['unbalanced'],
          lineCount: 2,
          debitsMinor: 5n,
          creditsMinor: 4n,
        },
      ],
      balanceMismatches: [
        {
          accountCode: '2000:merchant_payable:mch_1',
          environment: 'live',
          currency: 'UGX',
          recordedDebitsMinor: 1n,
          recordedCreditsMinor: 2n,
          journalDebitsMinor: 3n,
          journalCreditsMinor: 4n,
        },
      ],
      nonZeroSuspense: [
        { accountCode: '9000:suspense', environment: 'live', currency: 'UGX', balanceMinor: 7n },
      ],
      negativeMerchantBalances: [],
      unbalancedTotals: [
        { environment: 'live', currency: 'UGX', debitsMinor: 9n, creditsMinor: 8n },
      ],
    };
    const view = toIntegrityView(report);
    expect(view.invalidEntries[0]).toMatchObject({ debitsMinor: '5', creditsMinor: '4' });
    expect(view.balanceMismatches[0]).toMatchObject({
      recordedDebitsMinor: '1',
      journalCreditsMinor: '4',
    });
    expect(view.nonZeroSuspense[0]?.balanceMinor).toBe('7');
    expect(view.unbalancedTotals[0]).toMatchObject({ debitsMinor: '9', creditsMinor: '8' });
    expect(JSON.stringify(view)).not.toContain('n"');
  });
});
