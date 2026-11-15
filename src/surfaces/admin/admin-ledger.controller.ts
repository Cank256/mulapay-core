/**
 * Admin ledger reads (spec 7.3): accounts, statements, journal entries, trial balance and
 * the integrity report. Read-only. Adjustments and reversals need the approvals workflow
 * and are added with it.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RequirePermission } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { currencySchema, refSchema } from '../shared/schemas';
import { LedgerIntegrityService } from '../../modules/ledger/ledger-integrity.service';
import { LedgerQueryService } from '../../modules/ledger/ledger-query.service';
import {
  accountDetailSchema,
  accountPageSchema,
  entryDetailSchema,
  entryPageSchema,
  integritySchema,
  statementSchema,
  toAccountBalanceView,
  toAccountView,
  toEntryDetail,
  toEntrySummary,
  toIntegrityView,
  toStatementLine,
  toTrialBalanceView,
  trialBalanceSchema,
} from '../../modules/ledger/ledger.views';
const environmentSchema = z.enum(['test', 'live']);
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
};
const dateSchema = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
class ListAccountsDto extends createZodDto(
  z.strictObject({
    environment: environmentSchema.default('live'),
    purpose: z.string().max(40).optional(),
    merchant: refSchema.optional(),
    ...page,
  })
) {}
class AccountParamDto extends createZodDto(z.strictObject({ code: z.string().min(1).max(120) })) {}
class AccountEnvDto extends createZodDto(
  z.strictObject({ environment: environmentSchema.default('live') })
) {}
class StatementDto extends createZodDto(
  z.strictObject({
    environment: environmentSchema.default('live'),
    currency: currencySchema,
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    ...page,
  })
) {}
class ListEntriesDto extends createZodDto(
  z.strictObject({
    environment: environmentSchema.optional(),
    merchant: refSchema.optional(),
    source: z
      .enum(['payment', 'payout', 'refund', 'fee', 'settlement', 'adjustment', 'reversal'])
      .optional(),
    transactionId: z.uuid().optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    ...page,
  })
) {}
class EntryParamDto extends createZodDto(z.strictObject({ ref: refSchema })) {}
class TrialBalanceDto extends createZodDto(
  z.strictObject({ environment: environmentSchema.default('live'), currency: currencySchema })
) {}
class IntegrityDto extends createZodDto(
  z.strictObject({ from: dateSchema.optional(), to: dateSchema.optional() })
) {}
@ApiTags('Ledger')
@Controller()
export class AdminLedgerController {
  constructor(
    private readonly query: LedgerQueryService,
    private readonly integrity: LedgerIntegrityService
  ) {}
  @Get('accounts')
  @RequirePermission('ledger:read')
  @ApiOperation({ summary: 'Accounts of one environment, ordered by code' })
  @ApiEnvelopedResponses({ 200: accountPageSchema })
  async listAccounts(@Query() q: ListAccountsDto) {
    const result = await this.query.listAccounts({
      environment: q.environment,
      purpose: q.purpose,
      merchantRef: q.merchant,
      limit: q.limit,
      cursor: q.cursor,
    });
    return { items: result.items.map(toAccountView), nextCursor: result.nextCursor };
  }
  @Get('accounts/:code')
  @RequirePermission('ledger:read')
  @ApiOperation({ summary: 'One account with its posted balance per currency' })
  @ApiEnvelopedResponses({ 200: accountDetailSchema })
  async account(@Param() p: AccountParamDto, @Query() q: AccountEnvDto) {
    const detail = await this.query.getAccount(q.environment, p.code);
    return {
      account: toAccountView(detail.account),
      balances: detail.balances.map(toAccountBalanceView),
    };
  }
  @Get('accounts/:code/statement')
  @RequirePermission('ledger:read')
  @ApiOperation({ summary: 'Account statement with a running balance, oldest first' })
  @ApiEnvelopedResponses({ 200: statementSchema })
  async statement(@Param() p: AccountParamDto, @Query() q: StatementDto) {
    const result = await this.query.statement(p.code, q);
    return {
      account: toAccountView(result.account),
      currency: result.currency,
      from: result.window.from.toISOString(),
      to: result.window.to.toISOString(),
      items: result.items.map(toStatementLine),
      nextCursor: result.nextCursor,
    };
  }
  @Get('journal-entries')
  @RequirePermission('ledger:read')
  @ApiOperation({
    summary: 'Journal entries, newest first, within a date window (default 90 days)',
  })
  @ApiEnvelopedResponses({ 200: entryPageSchema })
  async listEntries(@Query() q: ListEntriesDto) {
    const result = await this.query.listEntries({ ...q, merchantRef: q.merchant });
    return { items: result.items.map(toEntrySummary), nextCursor: result.nextCursor };
  }
  @Get('journal-entries/:ref')
  @RequirePermission('ledger:read')
  @ApiOperation({ summary: 'One journal entry with its lines' })
  @ApiEnvelopedResponses({ 200: entryDetailSchema })
  async entry(@Param() p: EntryParamDto) {
    return toEntryDetail(await this.query.getEntry(p.ref));
  }
  @Get('trial-balance')
  @RequirePermission('ledger:read')
  @ApiOperation({ summary: 'Trial balance of one currency' })
  @ApiEnvelopedResponses({ 200: trialBalanceSchema })
  async trialBalance(@Query() q: TrialBalanceDto) {
    return toTrialBalanceView(await this.integrity.trialBalance(q.environment, q.currency));
  }
  @Get('ledger/integrity')
  @RequirePermission('ledger:read')
  @ApiOperation({
    summary: 'Ledger integrity report',
    description:
      'Unbalanced entries, accounts whose balance disagrees with the journal, non-zero ' +
      'suspense, negative merchant balances.',
  })
  @ApiEnvelopedResponses({ 200: integritySchema })
  async integrityReport(@Query() q: IntegrityDto) {
    return toIntegrityView(await this.integrity.check(q));
  }
}
