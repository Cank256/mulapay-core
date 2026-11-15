/**
 * Response shapes for merchants, members and invitations. Public refs only; internal
 * UUIDs, fee plan and settlement cycle ids are never exposed (spec section 11).
 */
import { z } from 'zod';
import type { MemberWithUser } from './members.repository';
import type { InvitationRow } from './invitations.repository';
import type { MerchantRow } from './merchants.repository';

export const merchantSchema = z.object({
  id: z.string(),
  legalName: z.string(),
  tradingName: z.string().nullable(),
  country: z.string(),
  defaultCurrency: z.string(),
  status: z.enum(['draft', 'pending_kyc', 'active', 'suspended', 'closed']),
  kycLevel: z.number().int(),
  riskRating: z.enum(['low', 'medium', 'high']).nullable(),
  mcc: z.string().nullable(),
  website: z.string().nullable(),
  supportEmail: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MerchantView = z.infer<typeof merchantSchema>;

export function toMerchantView(row: MerchantRow): MerchantView {
  return {
    id: row.ref,
    legalName: row.legalName,
    tradingName: row.tradingName,
    country: row.country,
    defaultCurrency: row.defaultCurrency,
    status: row.status as MerchantView['status'],
    kycLevel: row.kycLevel,
    riskRating: row.riskRating as MerchantView['riskRating'],
    mcc: row.mcc,
    website: row.website,
    supportEmail: row.supportEmail,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Fields written to audit rows for merchant changes. */
export function merchantAuditSnapshot(row: MerchantRow): Record<string, unknown> {
  const {
    id: _id,
    feePlanId: _f,
    settlementCycleId: _s,
    createdAt: _c,
    updatedAt: _u,
    ...rest
  } = row;
  return rest;
}

export const memberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'admin', 'developer', 'finance', 'support', 'viewer']),
  mfaEnabled: z.boolean(),
  joinedAt: z.iso.datetime(),
});
export type MemberView = z.infer<typeof memberSchema>;

export function toMemberView(row: MemberWithUser): MemberView {
  return {
    userId: row.userRef,
    name: row.name,
    email: row.email,
    role: row.role as MemberView['role'],
    mfaEnabled: row.mfaEnabled,
    joinedAt: row.joinedAt.toISOString(),
  };
}

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'admin', 'developer', 'finance', 'support', 'viewer']),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type InvitationView = z.infer<typeof invitationSchema>;

export function toInvitationView(row: InvitationRow, now: Date): InvitationView {
  return {
    id: row.ref,
    email: row.email,
    role: row.role as InvitationView['role'],
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= now.getTime(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** A newly created invitation carries its token exactly once. */
export const createdInvitationSchema = invitationSchema.extend({ token: z.string() });
export type CreatedInvitationView = z.infer<typeof createdInvitationSchema>;
