/**
 * API key management from the dashboard (spec 6.11 and 7.2 `/api-keys`).
 *
 * Invariants:
 * - The full key and the signing secret are returned once, by create and roll, and never
 *   stored or logged in clear: only SHA-256 of the key secret is stored, and the signing
 *   secret is stored AES-256-GCM encrypted because the server must recompute the HMAC.
 * - Live keys need an active merchant (KYC level 0 is test-only, spec 6.13).
 * - A live key that holds `payouts:write` always requires signed requests (spec 6.11).
 * - Rolling creates a successor with the same name, environment, scopes, allowlist and
 *   limits, and schedules the old key to stop working after a grace period of 0 to 7 days.
 *   A key can be rolled once; its successor is what gets rolled next.
 * - Revocation is immediate: once the change commits, the key is evicted from the Redis
 *   cache of every replica (`ApiKeyCache.evict`). If Redis is unreachable at that moment the
 *   revocation is still committed, and cached copies lapse within the 60 s cache TTL; the
 *   failure is logged at error level.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { ApiKeyCache } from '../../common/auth/api-key-cache';
import { generateSigningSecret, signingSecretContext } from '../../common/auth/signing-secret';
import type { Environment, MerchantStatus } from '../../common/auth/principal';
import { AuditService } from '../../common/audit/audit.service';
import type { ApiKeyScope } from '../../common/authz/permissions';
import type { Clock } from '../../common/clock/clock';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import type { Transaction } from '../../common/db/database.types';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { toLoggableError } from '../../common/logging/redaction';
import { CLOCK, ROOT_LOGGER } from '../../common/tokens';
import { merchantAllowsLiveKeys } from '../merchants/domain/merchant-lifecycle';
import { MerchantsRepository } from '../merchants/merchants.repository';
import { generateApiKey, type ApiKeyKind } from './api-key-format';
import { toApiKeyView, type ApiKeyView, type CreatedApiKeyView } from './api-key.views';
import { ApiKeysRepository, type ApiKeyRow } from './api-keys.repository';

export const MAX_ROLL_GRACE_HOURS = 168;

export interface CreateApiKeyInput {
  /**
   * `secret` today. A `publishable` key is refused until task P5-K4 decides what one may do:
   * no route is client-safe, so issuing one would hand out a credential that opens nothing.
   */
  readonly type?: ApiKeyKind;
  readonly name: string;
  readonly environment: Environment;
  readonly scopes: readonly ApiKeyScope[];
  readonly ipAllowlist?: readonly string[];
  readonly expiresAt?: Date;
  /** Write requests per minute for this key (spec 8.5); the platform default when absent. */
  readonly rateLimitRpm?: number;
  /** Require a signature on every request. Forced on for live keys with `payouts:write`. */
  readonly signingRequired?: boolean;
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
    rateLimitRpm: row.rateLimitRpm,
    signingRequired: row.signingRequired,
  };
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly keys: ApiKeysRepository,
    private readonly merchants: MerchantsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly cache: ApiKeyCache,
    private readonly encryption: FieldEncryption,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ROOT_LOGGER) private readonly logger: Logger
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
    if (input.type === 'publishable') {
      throw new AppError('VALIDATION_FAILED', {
        details: {
          fields: [
            {
              path: 'type',
              code: 'invalid_value',
              message: 'publishable keys are not available yet',
            },
          ],
        },
      });
    }
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
      return {
        ...toApiKeyView(issued.row, now),
        key: issued.key,
        signingSecret: issued.signingSecret,
      };
    });
  }

  async roll(
    merchantId: string,
    ref: string,
    graceHours: number,
    actor: { userId: string }
  ): Promise<CreatedApiKeyView> {
    const { created, retiredKeyId } = await this.unitOfWork.run(async (tx) => {
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
          rateLimitRpm: old.rateLimitRpm ?? undefined,
          signingRequired: old.signingRequired,
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
      return {
        created: {
          ...toApiKeyView(issued.row, now),
          key: issued.key,
          signingSecret: issued.signingSecret,
        },
        retiredKeyId: old.keyId,
      };
    });
    await this.evict(retiredKeyId);
    return created;
  }

  async revoke(merchantId: string, ref: string, actor: { userId: string }): Promise<void> {
    const keyId = await this.unitOfWork.run(async (tx) => {
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
      return row.keyId;
    });
    await this.evict(keyId);
  }

  /** After commit: the change is durable whether or not Redis answers (see class comment). */
  private async evict(keyId: string): Promise<void> {
    try {
      await this.cache.evict(keyId);
    } catch (error) {
      this.logger.error(
        { err: toLoggableError(error), keyId },
        'api key cache eviction failed; cached copies expire within 60 seconds'
      );
    }
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
    const generated = generateApiKey(input.environment, 'secret');
    const ref = publicId('apiKey', now);
    const scopes = [...new Set(input.scopes)];
    const signingRequired =
      input.signingRequired === true ||
      (input.environment === 'live' && scopes.includes('payouts:write'));
    // Without a data key (local development) a key is issued without a signing secret,
    // unless signing is required, in which case issuing fails rather than weaken the key.
    const signingSecret =
      this.encryption.available || signingRequired ? generateSigningSecret() : null;
    const row = await this.keys.insert(tx, {
      id: uuidv7(now),
      ref,
      merchantId,
      environment: input.environment,
      keyId: generated.keyId,
      secretHash: generated.secretHash,
      name: input.name,
      scopes,
      ipAllowlist:
        input.ipAllowlist && input.ipAllowlist.length > 0 ? [...input.ipAllowlist] : null,
      rateLimitRpm: input.rateLimitRpm ?? null,
      signingSecretEnc: signingSecret
        ? this.encryption.encrypt(signingSecret, signingSecretContext(ref))
        : null,
      signingRequired,
      expiresAt: input.expiresAt ?? null,
      createdBy,
      rolledFromId,
    });
    return { row, key: generated.key, signingSecret };
  }
}

function earliest(a: Date | null, b: Date): Date {
  return a && a.getTime() < b.getTime() ? a : b;
}
