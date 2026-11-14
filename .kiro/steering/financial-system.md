# Financial System Rules

MulaPay is a financial system.

All monetary amounts use bigint minor units.

Never use floating-point numbers for financial amounts.

The ledger uses double-entry accounting.

Every posted journal transaction must balance:

total debits = total credits

Posted journal entries are immutable.

Never update or delete posted ledger entries.

Financial corrections use reversing or compensating entries.

Balances must remain consistent with the ledger.

Every financial operation requires idempotency protection.

Financial operations must define:
- successful outcome
- failed outcome
- ambiguous outcome
- retry behaviour
- duplicate behaviour
- reversal behaviour

Do not alter financial invariants to make tests pass.

Database constraints must enforce critical financial invariants where practical.

Payouts must use holds before external disbursement.

A successful payout captures the appropriate hold.

A failed payout releases the appropriate hold.

An ambiguous payout outcome must enter controlled reconciliation/status verification rather than being assumed successful or failed.

Provider callbacks do not independently establish financial truth.

External provider status must be verified where required.

Late provider events must be handled safely.

Never create financial state through an untracked balance mutation.

Every financial posting must have an auditable reference to the originating business operation.