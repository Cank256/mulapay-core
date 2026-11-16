/**
 * Post-transaction monitoring (spec 6.13 step 3): runs asynchronously for every terminal live
 * payment, evaluates the enabled rules, raises alerts and carries out the rules' actions.
 *
 * Invariants upheld:
 *  - Idempotent. The transaction's fact row is its marker: the job finds it already written
 *    and does nothing, and an alert is unique per rule and transaction, so a retried or
 *    duplicated job has one effect.
 *  - One transaction. The fact, the alerts, and the holds or block they trigger commit
 *    together or not at all, under a per-merchant advisory lock, so two jobs for one
 *    merchant see each other's facts and a velocity count cannot be missed by a race.
 *  - Actions never reverse money. `flag` raises an alert. `hold` also holds the payment's
 *    amount (or what is available of it) on the merchant balance. `block` also blocks the
 *    merchant (holds and no payouts). A completed transaction is never altered.
 *  - A rule that cannot be read (bad params) is skipped and logged; it does not stop the
 *    other rules or the job.
 *  - The payer's number is decrypted in memory only to hash it and to match geography
 *    prefixes. It is never stored in clear, logged, or put in an alert.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Clock } from '../../../common/clock/clock';
import { FieldEncryption } from '../../../common/crypto/field-encryption';
import { PiiHasher } from '../../../common/crypto/pii-hasher';
import type { Transaction } from '../../../common/db/database.types';
import { UnitOfWork } from '../../../common/db/unit-of-work';
import { toLoggableError } from '../../../common/logging/redaction';
import { CLOCK, ROOT_LOGGER, APP_CONFIG } from '../../../common/tokens';
import type { AppConfig } from '../../../config/configuration';
import { BalancesService } from '../../balances/balances.service';
import { HoldsService } from '../../holds/holds.service';
import { AmlAlertsRepository, type AlertRow } from '../alerts/aml-alerts.repository';
import { AmlAlertsService } from '../alerts/aml-alerts.service';
import { AmlBlockService } from '../block/aml-block.service';
import {
  alertScore,
  evaluateRule,
  ruleIsEffective,
  type MonitoredTransaction,
  type Severity,
} from '../domain/rule-evaluation';
import { parseRuleParams, TERMINAL_STATUSES, type TerminalStatus } from '../domain/rule-params';
import { alertDueAt } from '../domain/sla';
import { AmlRulesRepository, type RuleRow } from '../rules/aml-rules.repository';
import { AuditService } from '../../../common/audit/audit.service';
import { AmlFactsRepository } from './aml-facts.repository';

export type MonitorOutcome =
  | { readonly result: 'not_applicable'; readonly reason: string }
  | { readonly result: 'already_monitored' }
  | {
      readonly result: 'monitored';
      readonly rulesEvaluated: number;
      readonly alerts: string[];
      readonly blocked: boolean;
    };

function isTerminal(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

@Injectable()
export class AmlMonitoringService {
  constructor(
    private readonly facts: AmlFactsRepository,
    private readonly rules: AmlRulesRepository,
    private readonly alerts: AmlAlertsService,
    private readonly alertRepository: AmlAlertsRepository,
    private readonly blocks: AmlBlockService,
    private readonly holds: HoldsService,
    private readonly balances: BalancesService,
    private readonly encryption: FieldEncryption,
    private readonly hasher: PiiHasher,
    private readonly audit: AuditService,
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
  ) {}

  /** Monitors one terminal transaction. Safe to call any number of times for the same one. */
  async monitor(transactionId: string): Promise<MonitorOutcome> {
    return this.unitOfWork.run(async (tx) => {
      const row = await this.facts.loadTransaction(tx, transactionId);
      if (!row) return { result: 'not_applicable', reason: 'unknown_transaction' } as const;
      if (row.environment !== 'live')
        return { result: 'not_applicable', reason: 'not_live' } as const;
      if (row.type !== 'payment')
        return { result: 'not_applicable', reason: 'not_a_payment' } as const;
      if (!isTerminal(row.status) || !row.completedAt) {
        return { result: 'not_applicable', reason: 'not_terminal' } as const;
      }
      await this.facts.lockMerchant(tx, row.merchantId);

      const msisdn = this.payerNumber(row.paymentRef, row.msisdnEnc);
      const counterpartyHmac = msisdn ? this.hasher.digest('counterparty', msisdn) : null;
      const inserted = await this.facts.insertFact(tx, {
        transactionId: row.id,
        merchantId: row.merchantId,
        currency: row.currency,
        amountMinor: row.amountMinor,
        status: row.status,
        channel: row.channel,
        counterpartyHmac,
        completedAt: row.completedAt,
      });
      if (!inserted) return { result: 'already_monitored' } as const;

      const createdAt = await this.facts.merchantCreatedAt(tx, row.merchantId);
      if (!createdAt) return { result: 'not_applicable', reason: 'unknown_merchant' } as const;
      const monitored: MonitoredTransaction = {
        amountMinor: row.amountMinor,
        currency: row.currency,
        status: row.status,
        completedAt: row.completedAt,
        msisdn,
        counterpartyHmac,
      };
      const ruleFacts = this.facts.factsFor(tx, {
        merchantId: row.merchantId,
        currency: row.currency,
        completedAt: row.completedAt,
        counterpartyHmac,
      });

      const raised: string[] = [];
      let evaluated = 0;
      let blocked = false;
      for (const rule of await this.rules.listEnabled(tx)) {
        if (!ruleIsEffective(rule, row.completedAt)) continue;
        const parsed = parseRuleParams(rule.ruleType, rule.params);
        if (!parsed.ok) {
          this.logger.error(
            { rule: rule.code, issues: parsed.issues },
            'aml rule has invalid params; skipped'
          );
          continue;
        }
        evaluated += 1;
        const verdict = await evaluateRule(parsed.rule, monitored, { createdAt }, ruleFacts);
        if (!verdict.fired) continue;
        const severity = rule.severity as Severity;
        const { alert, created } = await this.alerts.raise(tx, {
          ruleCode: rule.code,
          ruleVersion: rule.version,
          ruleType: rule.ruleType,
          severity,
          action: rule.action as 'flag' | 'hold' | 'block',
          merchantId: row.merchantId,
          transactionId: row.id,
          score: alertScore(severity, verdict.excess),
          details: verdict.details,
          dueAt: alertDueAt(severity, this.clock.now(), this.config),
        });
        if (!created) continue;
        raised.push(alert.ref);
        if (rule.action === 'hold') {
          await this.holdForAlert(tx, alert, row.amountMinor, row.currency);
        } else if (rule.action === 'block') {
          blocked = (await this.blockForAlert(tx, alert, rule)) || blocked;
        }
      }
      return { result: 'monitored', rulesEvaluated: evaluated, alerts: raised, blocked } as const;
    });
  }

  /** Holds the payment's amount, or what is available of it. Records any shortfall. */
  private async holdForAlert(
    tx: Transaction,
    alert: AlertRow,
    amountMinor: bigint,
    currency: string
  ): Promise<void> {
    const balance = await this.balances.lockedMerchantBalance(
      tx,
      alert.merchantId,
      'live',
      currency
    );
    const heldMinor = balance.availableMinor < amountMinor ? balance.availableMinor : amountMinor;
    if (heldMinor <= 0n) {
      await this.audit.record(tx, {
        action: 'aml.alert.hold_skipped',
        resourceType: 'aml_alert',
        resourceId: alert.ref,
        merchantId: alert.merchantId,
        after: { reason: 'nothing_available', requestedMinor: amountMinor.toString(), currency },
        actor: { type: 'job', id: 'aml-monitoring', label: 'AML transaction monitoring' },
      });
      return;
    }
    const { hold } = await this.holds.place(tx, {
      merchantId: alert.merchantId,
      environment: 'live',
      currency,
      amountMinor: heldMinor,
      reason: `aml:alert:${alert.ref}`,
      idempotencyKey: `aml-alert-hold:${alert.ref}`,
      createdBy: 'system:aml',
    });
    await this.alertRepository.update(tx, alert.id, { holdId: hold.id });
    await this.audit.record(tx, {
      action: 'aml.alert.hold_placed',
      resourceType: 'aml_alert',
      resourceId: alert.ref,
      merchantId: alert.merchantId,
      after: {
        hold: hold.ref,
        heldMinor: heldMinor.toString(),
        requestedMinor: amountMinor.toString(),
        currency,
      },
      actor: { type: 'job', id: 'aml-monitoring', label: 'AML transaction monitoring' },
    });
  }

  private async blockForAlert(tx: Transaction, alert: AlertRow, rule: RuleRow): Promise<boolean> {
    const result = await this.blocks.applyInTx(tx, {
      merchantId: alert.merchantId,
      reason: `rule ${rule.code}, alert ${alert.ref}`,
      source: 'rule',
      alertId: alert.id,
      createdBy: 'system:aml',
    });
    return result.created;
  }

  private payerNumber(paymentRef: string | null, enc: string | null): string | null {
    if (!paymentRef || !enc) return null;
    try {
      return this.encryption.decrypt(enc, `payments.msisdn:${paymentRef}`);
    } catch (error) {
      this.logger.warn(
        { err: toLoggableError(error), paymentRef },
        'payer number could not be read for monitoring; rules that need it are skipped'
      );
      return null;
    }
  }
}
