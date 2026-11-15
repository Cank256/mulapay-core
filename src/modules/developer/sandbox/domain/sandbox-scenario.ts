/**
 * The sandbox simulator's scenarios (spec 6.11). A payment made with a test key is resolved
 * deterministically, from `metadata.simulate` when present, otherwise from the last two
 * digits of the amount in minor units. Pure: no I/O.
 *
 * | Scenario               | What the merchant sees                                                    |
 * | ---------------------- | ------------------------------------------------------------------------- |
 * | `succeed`              | processing, then `payment.succeeded`                                      |
 * | `fail`                 | processing, then `payment.failed` (`sandbox_declined`)                    |
 * | `expire`               | processing, then `payment.expired` (`sandbox_expired`)                    |
 * | `timeout`              | processing with an unknown outcome and no event; after the sandbox        |
 * |                        | timeout it ends `payment.expired` (`sandbox_timeout`)                     |
 * | `pending_then_succeed` | processing, then after the sandbox delay `payment.succeeded`              |
 *
 * Last two digits of the minor-unit amount (so 1 000 UGX is `00`, 10.04 USD is `04`):
 * `01` fail, `02` timeout, `03` expire, `04` pending_then_succeed, anything else succeed.
 */
export const SANDBOX_SCENARIOS = [
  'succeed',
  'fail',
  'timeout',
  'expire',
  'pending_then_succeed',
] as const;
export type SandboxScenario = (typeof SANDBOX_SCENARIOS)[number];

export const AMOUNT_SCENARIOS: Readonly<Record<number, SandboxScenario>> = {
  1: 'fail',
  2: 'timeout',
  3: 'expire',
  4: 'pending_then_succeed',
};

export function isSandboxScenario(value: string): value is SandboxScenario {
  return (SANDBOX_SCENARIOS as readonly string[]).includes(value);
}

/** The scenario for a payment. An unrecognised `simulate` value is refused at creation, never here. */
export function resolveScenario(input: {
  readonly amountMinor: bigint;
  readonly metadata: Readonly<Record<string, string>>;
}): SandboxScenario {
  const requested = input.metadata.simulate;
  if (requested !== undefined && isSandboxScenario(requested)) return requested;
  const lastTwo = Number(input.amountMinor % 100n);
  return AMOUNT_SCENARIOS[lastTwo] ?? 'succeed';
}

/** The provider a simulated payment is attributed to when the merchant pinned none. */
export const SANDBOX_DEFAULT_PROVIDER = 'mtn';

export type SandboxStep = 'start' | 'finish';

export interface SandboxPlan {
  /** Whether the first step reports an unknown outcome (a simulated gateway timeout). */
  readonly outcomeUnknown: boolean;
  /** The terminal state the second step applies. */
  readonly terminal: 'succeeded' | 'failed' | 'expired';
  readonly failureCode?: string;
  /** Seconds the second step waits after the first: 0 means in the same job. */
  readonly delay: 'none' | 'pending' | 'timeout';
}

export function planFor(scenario: SandboxScenario): SandboxPlan {
  switch (scenario) {
    case 'succeed':
      return { outcomeUnknown: false, terminal: 'succeeded', delay: 'none' };
    case 'fail':
      return {
        outcomeUnknown: false,
        terminal: 'failed',
        failureCode: 'sandbox_declined',
        delay: 'none',
      };
    case 'expire':
      return {
        outcomeUnknown: false,
        terminal: 'expired',
        failureCode: 'sandbox_expired',
        delay: 'none',
      };
    case 'timeout':
      return {
        outcomeUnknown: true,
        terminal: 'expired',
        failureCode: 'sandbox_timeout',
        delay: 'timeout',
      };
    case 'pending_then_succeed':
      return { outcomeUnknown: false, terminal: 'succeeded', delay: 'pending' };
  }
}
