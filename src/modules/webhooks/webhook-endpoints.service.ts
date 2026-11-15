/**
 * Webhook endpoint management (spec 6.11, 7.1 `/webhook-endpoints`).
 *
 * Invariants:
 *  - The signing secret is returned once, by create and rotate; it is stored AES-256-GCM
 *    encrypted, bound to its endpoint, and never logged or audited.
 *  - A URL is validated when registered and again when delivered (see `endpoint-url.ts`).
 *  - Every change and its audit row commit together.
 *  - Enabling an endpoint that was disabled, by the merchant or after 50 consecutive
 *    failures, clears the failure count so it gets a fresh run.
 *  - Deleting is soft: delivery history keeps pointing at the endpoint.
 *  - Rotation keeps the previous secret signing deliveries for `graceHours` (the header then
 *    carries two `v1` signatures), so a receiver can switch secrets without losing events.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { MerchantScope } from '../../common/auth/merchant-scope';
import { AuditService } from '../../common/audit/audit.service';
import type { Clock } from '../../common/clock/clock';
import { sha256Hex } from '../../common/crypto/crypto';
import { FieldEncryption } from '../../common/crypto/field-encryption';
import { UnitOfWork } from '../../common/db/unit-of-work';
import { AppError } from '../../common/errors/app-error';
import { publicId, uuidv7 } from '../../common/ids/ids';
import { APP_CONFIG, CLOCK } from '../../common/tokens';
import type { AppConfig } from '../../config/configuration';
import { ALL_EVENTS } from '../events/domain/event-types';
import { validateWebhookUrl } from './domain/endpoint-url';
import {
  toWebhookEndpointView,
  type CreatedWebhookEndpointView,
  type WebhookEndpointView,
} from './webhook-endpoint.views';
import {
  MAX_ENDPOINTS_PER_ENVIRONMENT,
  WebhookEndpointsRepository,
  type WebhookEndpointRow,
} from './webhook-endpoints.repository';

export const MAX_SECRET_GRACE_HOURS = 72;

export interface CreateEndpointInput {
  readonly url: string;
  readonly description?: string;
  readonly enabledEvents: readonly string[];
}

export interface UpdateEndpointInput {
  readonly url?: string;
  readonly description?: string | null;
  readonly enabledEvents?: readonly string[];
  /** `active` re-enables, `disabled` pauses. `auto_disabled` is set only by the platform. */
  readonly status?: 'active' | 'disabled';
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}

/** The associated data binding a stored webhook secret to its endpoint. */
export function webhookSecretContext(endpointRef: string): string {
  return `webhook_endpoints.secret:${endpointRef}`;
}

/** `*` subsumes the rest; duplicates are dropped; order is stable. */
function normalizeEvents(events: readonly string[]): string[] {
  return events.includes(ALL_EVENTS) ? [ALL_EVENTS] : [...new Set(events)].sort();
}

/**
 * What the audit trail records of a URL: the host, and a hash that shows it changed. Merchants
 * often put a token in the path or query of a webhook URL, and the audit trail is read by staff
 * and kept for years.
 */
function auditUrl(url: string): { urlHost: string; urlSha256: string } {
  return { urlHost: new URL(url).host, urlSha256: sha256Hex(url).slice(0, 16) };
}

function snapshot(row: WebhookEndpointRow) {
  return {
    ...auditUrl(row.url),
    description: row.description,
    enabledEvents: row.enabledEvents,
    status: row.status,
    environment: row.environment,
  };
}

@Injectable()
export class WebhookEndpointsService {
  constructor(
    private readonly endpoints: WebhookEndpointsRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly encryption: FieldEncryption,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'WEBHOOK_ALLOW_PRIVATE_NETWORKS'>
  ) {}

  private checkUrl(url: string): string {
    return validateWebhookUrl(url, {
      allowPrivateNetworks: this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS,
    });
  }

  async list(scope: MerchantScope): Promise<WebhookEndpointView[]> {
    return (await this.endpoints.list(scope)).map(toWebhookEndpointView);
  }

  async get(scope: MerchantScope, ref: string): Promise<WebhookEndpointView> {
    const row = await this.endpoints.findByRef(scope, ref);
    if (!row) throw new AppError('NOT_FOUND');
    return toWebhookEndpointView(row);
  }

  async create(
    scope: MerchantScope,
    input: CreateEndpointInput
  ): Promise<CreatedWebhookEndpointView> {
    const url = this.checkUrl(input.url);
    const now = this.clock.now();
    const ref = publicId('webhookEndpoint', now);
    const secret = generateWebhookSecret();
    return this.unitOfWork.run(async (tx) => {
      if ((await this.endpoints.countLive(tx, scope)) >= MAX_ENDPOINTS_PER_ENVIRONMENT) {
        throw new AppError('WEBHOOK_ENDPOINT_LIMIT_REACHED');
      }
      const row = await this.endpoints.insert(tx, {
        id: uuidv7(now),
        ref,
        merchantId: scope.merchantId,
        environment: scope.environment,
        url,
        description: input.description ?? null,
        enabledEvents: normalizeEvents(input.enabledEvents),
        secretEnc: this.encryption.encrypt(secret, webhookSecretContext(ref)),
      });
      await this.audit.record(tx, {
        action: 'webhook_endpoint.created',
        resourceType: 'webhook_endpoint',
        resourceId: row.ref,
        merchantId: scope.merchantId,
        after: snapshot(row),
      });
      return { ...toWebhookEndpointView(row), secret };
    });
  }

  async update(
    scope: MerchantScope,
    ref: string,
    input: UpdateEndpointInput
  ): Promise<WebhookEndpointView> {
    const url = input.url === undefined ? undefined : this.checkUrl(input.url);
    return this.unitOfWork.run(async (tx) => {
      const before = await this.endpoints.lockByRef(tx, scope, ref);
      if (!before) throw new AppError('NOT_FOUND');
      const now = this.clock.now();
      const reenable = input.status === 'active' && before.status !== 'active';
      const disable = input.status === 'disabled' && before.status === 'active';
      const after = await this.endpoints.update(tx, before.id, {
        ...(url === undefined ? {} : { url }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.enabledEvents ? { enabledEvents: normalizeEvents(input.enabledEvents) } : {}),
        ...(reenable ? { status: 'active', disabledAt: null, failureCount: 0 } : {}),
        ...(disable ? { status: 'disabled', disabledAt: now } : {}),
      });
      await this.audit.record(tx, {
        action: 'webhook_endpoint.updated',
        resourceType: 'webhook_endpoint',
        resourceId: after.ref,
        merchantId: scope.merchantId,
        before: snapshot(before),
        after: snapshot(after),
      });
      return toWebhookEndpointView(after);
    });
  }

  async delete(scope: MerchantScope, ref: string): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const before = await this.endpoints.lockByRef(tx, scope, ref);
      if (!before) throw new AppError('NOT_FOUND');
      const now = this.clock.now();
      const after = await this.endpoints.update(tx, before.id, {
        status: 'disabled',
        disabledAt: before.disabledAt ?? now,
        deletedAt: now,
      });
      await this.audit.record(tx, {
        action: 'webhook_endpoint.deleted',
        resourceType: 'webhook_endpoint',
        resourceId: after.ref,
        merchantId: scope.merchantId,
        before: snapshot(before),
        after: null,
      });
    });
  }

  /** Issues a new secret. The old one keeps signing for `graceHours` (0 ends it at once). */
  async rotateSecret(
    scope: MerchantScope,
    ref: string,
    graceHours: number
  ): Promise<CreatedWebhookEndpointView> {
    const secret = generateWebhookSecret();
    return this.unitOfWork.run(async (tx) => {
      const before = await this.endpoints.lockByRef(tx, scope, ref);
      if (!before) throw new AppError('NOT_FOUND');
      const now = this.clock.now();
      const keepPrevious = graceHours > 0;
      const after = await this.endpoints.update(tx, before.id, {
        secretEnc: this.encryption.encrypt(secret, webhookSecretContext(before.ref)),
        previousSecretEnc: keepPrevious ? before.secretEnc : null,
        previousSecretExpiresAt: keepPrevious
          ? new Date(now.getTime() + graceHours * 3_600_000)
          : null,
      });
      await this.audit.record(tx, {
        action: 'webhook_endpoint.secret_rotated',
        resourceType: 'webhook_endpoint',
        resourceId: after.ref,
        merchantId: scope.merchantId,
        after: { graceHours },
      });
      return { ...toWebhookEndpointView(after), secret };
    });
  }

  /**
   * The secrets that sign a delivery now: the current one and, during a rotation's grace
   * period, the previous one. Used by the delivery service.
   */
  signingSecrets(row: WebhookEndpointRow, now: Date): string[] {
    const secrets = [this.encryption.decrypt(row.secretEnc, webhookSecretContext(row.ref))];
    if (
      row.previousSecretEnc &&
      row.previousSecretExpiresAt &&
      row.previousSecretExpiresAt.getTime() > now.getTime()
    ) {
      secrets.push(this.encryption.decrypt(row.previousSecretEnc, webhookSecretContext(row.ref)));
    }
    return secrets;
  }
}
