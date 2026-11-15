/**
 * API key management from the dashboard (spec 6.11 and 7.2 `/api-keys`).
 *
 * Invariants:
 * - The full key is returned once, by create and roll, and never stored or logged.
 * - Live keys need an active merchant (KYC level 0 is test-only, spec 6.13).
 * - Rolling creates a successor with the same name, environment, scopes and allowlist,
 *   and schedules the old key to stop working after a grace period of 0 to 7 days. A key
 *   can be rolled once; its successor is what gets rolled next.
 * - Revocation is immediate: there is no key cache yet (Phase 5 adds one, with pub/sub
 *   eviction), so the next request with the key is refused.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Environment, MerchantStatus } from '../../common/auth/principal';
import { AuditService } from '../../common/audit/audit.service';
import type { ApiKeyScope } from '../../common/authz/permissions';
import type { Clock } from '../../common/clock/clock';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { CLOCK } from '../../common/tokens';
import { merchantAllowsLiveKeys } from '../merchants/domain/merchant-lifecycle';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { generateApiKey } from './api-key-format';
import { toApiKeyView, type ApiKeyView, type CreatedApiKeyView } from './api-key.views';
import { ApiKeysRepository, type ApiKeyRow } from './api-keys.repository';

export const MAX_ROLL_GRACE_HOURS = 168;

export interface CreateApiKeyInput {
  readonly name: string;
  readonly environment: Environment;
  readonly scopes: readonly ApiKeyScope[];
  readonly ipAllowlist?: readonly string[];
  readonly expiresAt?: Date;
}

export function isKeyUsable(row: Pick<ApiKeyRow, 'revokedAt' | 'expiresAt'>, now: Date): boolean {
  return (
    row.revokedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime())
  );
}

function auditSnapshot(row: ApiKeyRow) {
  return {
    name: row.name,
    environment: row.environment,
    keyId: row.keyId,
    scopes: row.scopes,
    ipAllowlist: row.ipAllowlist,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly merchants: MerchantsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async list(merchantId: string): Promise<ApiKeyView[]> {
    const now = this.clock.now();
    return (await this.keys.list(merchantId)).map((row) => toApiKeyView(row, now));
  }

  async create(
    merchantId: string,
    input: CreateApiKeyInput,
    actor: { userId: string }
  ): Promise<CreatedApiKeyView> {
    const now = this.clock.now();
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('VALIDATION_FAILED', {
        details: {
          fields: [{ path: 'expiresAt', code: 'too_small', message: 'must be in the future' }],
        },
      });
    }
    return this.unitOfWork.run(async (tx) => {
      await this.assertMayIssue(tx, merchantId, input.environment);
      const issued = await this.insertKey(tx, merchantId, input, actor.userId, null);
      await this.audit.record(tx, {
        action: 'api_key.created',
        resourceType: 'api_key',
        resourceId: issued.row.ref,
        merchantId,
        after: auditSnapshot(issued.row),
      });
      return { ...toApiKeyView(issued.row, now), key: issued.key };
    });
  }

  async roll(
    merchantId: string,
    ref: string,
    graceHours: number,
    actor: { userId: string }
  ): Promise<CreatedApiKeyView> {
    return this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      const old = await this.keys.lockByRef(tx, merchantId, ref);
      if (!old) throw new AppError('NOT_FOUND');
      if (!isKeyUsable(old, now) || (await this.keys.hasSuccessor(tx, merchantId, old.id))) {
        throw new AppError('API_KEY_REVOKED');
      }
      await this.assertMayIssue(tx, merchantId, old.environment as Environment);
      const issued = await this.insertKey(
        tx,
        merchantId,
        {
          name: old.name,
          environment: old.environment as Environment,
          scopes: old.scopes as ApiKeyScope[],
          ipAllowlist: old.ipAllowlist ?? undefined,
          expiresAt: old.expiresAt ?? undefined,
        },
        actor.userId,
        old.id
      );
      const retired =
        graceHours === 0
          ? await this.keys.revoke(tx, merchantId, old.id, now, actor.userId)
          : await this.keys.setExpiry(
              tx,
              merchantId,
              old.id,
              earliest(old.expiresAt, new Date(now.getTime() + graceHours * 3_600_000))
            );
      await this.audit.record(tx, {
        action: 'api_key.rolled',
        resourceType: 'api_key',
        resourceId: old.ref,
        merchantId,
        before: auditSnapshot(old),
        after: {
          ...(retired ? auditSnapshot(retired) : {}),
          replacedBy: issued.row.ref,
          graceHours,
        },
      });
      return { ...toApiKeyView(issued.row, now), key: issued.key };
    });
  }

  async revoke(merchantId: string, ref: string, actor: { userId: string }): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const now = this.clock.now();
      const row = await this.keys.lockByRef(tx, merchantId, ref);
      if (!row) throw new AppError('NOT_FOUND');
      if (row.revokedAt) throw new AppError('API_KEY_REVOKED');
      const revoked = await this.keys.revoke(tx, merchantId, row.id, now, actor.userId);
      await this.audit.record(tx, {
        action: 'api_key.revoked',
        resourceType: 'api_key',
        resourceId: row.ref,
        merchantId,
        before: auditSnapshot(row),
        after: revoked ? auditSnapshot(revoked) : null,
      });
    });
  }

  private async assertMayIssue(tx: Transaction, merchantId: string, environment: Environment) {
    const merchant = await this.merchants.lockById(tx, merchantId);
    if (!merchant) throw new AppError('NOT_FOUND');
    if (environment === 'live' && !merchantAllowsLiveKeys(merchant.status as MerchantStatus)) {
      throw new AppError('MERCHANT_NOT_ACTIVE');
    }
  }

  private async insertKey(
    tx: Transaction,
    merchantId: string,
    input: CreateApiKeyInput,
    createdBy: string,
    rolledFromId: string | null
  ) {
    const now = this.clock.now();
    const generated = generateApiKey(input.environment);
    const row = await this.keys.insert(tx, {
      id: uuidv7(now),
      ref: publicId('apiKey', now),
      merchantId,
      environment: input.environment,
      keyId: generated.keyId,
      secretHash: generated.secretHash,
      name: input.name,
      scopes: [...new Set(input.scopes)],
      ipAllowlist:
        input.ipAllowlist && input.ipAllowlist.length > 0 ? [...input.ipAllowlist] : null,
      expiresAt: input.expiresAt ?? null,
      createdBy,
      rolledFromId,
    });
    return { row, key: generated.key };
  }
}

function earliest(a: Date | null, b: Date): Date {
  return a && a.getTime() < b.getTime() ? a : b;
}
