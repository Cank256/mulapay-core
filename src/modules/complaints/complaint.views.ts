/**
 * What a complaint looks like on the API (spec 7.2, 7.3). A merchant sees its complaint, the
 * public messages, the resolution and the deadline. Staff also see who it is assigned to,
 * whether it breached, the escalation, and the internal notes. A customer's contact is in
 * neither: it has its own audited route.
 */
import { z } from 'zod';
import { COMPLAINT_PRIORITIES, COMPLAINT_STATUSES } from '../../db/schema';
import type { ComplaintDetail } from './complaints.service';
import type { ComplaintWithRefs, MessageRow } from './complaints.repository';

const iso = z.string();

export const complaintMessageSchema = z.object({
  id: z.string(),
  authorType: z.enum(['merchant', 'admin', 'system', 'customer']),
  body: z.string(),
  createdAt: iso,
});
export const adminComplaintMessageSchema = complaintMessageSchema.extend({
  internal: z.boolean(),
  author: z.string().nullable(),
});

export const merchantComplaintSchema = z.object({
  id: z.string(),
  category: z.string(),
  subject: z.string(),
  description: z.string(),
  transaction: z.string().nullable(),
  priority: z.enum(COMPLAINT_PRIORITIES),
  status: z.enum(COMPLAINT_STATUSES),
  slaDueAt: iso,
  resolution: z.string().nullable(),
  resolvedAt: iso.nullable(),
  closedAt: iso.nullable(),
  satisfactionScore: z.number().int().nullable(),
  createdAt: iso,
});
export const merchantComplaintDetailSchema = merchantComplaintSchema.extend({
  messages: z.array(complaintMessageSchema),
});
export const merchantComplaintPageSchema = z.object({
  items: z.array(merchantComplaintSchema),
  nextCursor: z.string().nullable(),
});

export const adminComplaintSchema = merchantComplaintSchema.extend({
  source: z.enum(['merchant', 'customer', 'admin']),
  merchant: z.string().nullable(),
  assignee: z.string().nullable(),
  assignedAt: iso.nullable(),
  breached: z.boolean(),
  breachedAt: iso.nullable(),
  escalatedAt: iso.nullable(),
  escalationReason: z.string().nullable(),
  hasCustomerContact: z.boolean(),
});
export const adminComplaintDetailSchema = adminComplaintSchema.extend({
  messages: z.array(adminComplaintMessageSchema),
});
export const adminComplaintPageSchema = z.object({
  items: z.array(adminComplaintSchema),
  nextCursor: z.string().nullable(),
});
export const customerContactSchema = z.object({ contact: z.string().nullable() });

export const complaintCategorySchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  slaHours: z.number().int(),
  defaultPriority: z.enum(COMPLAINT_PRIORITIES),
});
export const complaintCategoriesSchema = z.object({ items: z.array(complaintCategorySchema) });

export function toMerchantComplaint(
  found: ComplaintWithRefs
): z.infer<typeof merchantComplaintSchema> {
  const { row } = found;
  return {
    id: row.ref,
    category: row.category,
    subject: row.subject,
    description: row.description,
    transaction: found.transactionRef,
    priority: row.priority as z.infer<typeof merchantComplaintSchema>['priority'],
    status: row.status as z.infer<typeof merchantComplaintSchema>['status'],
    slaDueAt: row.slaDueAt.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    satisfactionScore: row.satisfactionScore,
    createdAt: row.createdAt.toISOString(),
  };
}

const toMessage = (m: MessageRow) => ({
  id: m.id,
  authorType: m.authorType as z.infer<typeof complaintMessageSchema>['authorType'],
  body: m.body,
  createdAt: m.createdAt.toISOString(),
});

export function toMerchantComplaintDetail(detail: ComplaintDetail) {
  return {
    ...toMerchantComplaint(detail.complaint),
    messages: detail.messages.map((m) => toMessage(m.row)),
  };
}

export function toAdminComplaint(found: ComplaintWithRefs): z.infer<typeof adminComplaintSchema> {
  const { row } = found;
  return {
    ...toMerchantComplaint(found),
    source: row.source as z.infer<typeof adminComplaintSchema>['source'],
    merchant: found.merchantRef,
    assignee: found.assigneeRef,
    assignedAt: row.assignedAt?.toISOString() ?? null,
    breached: row.breached,
    breachedAt: row.breachedAt?.toISOString() ?? null,
    escalatedAt: row.escalatedAt?.toISOString() ?? null,
    escalationReason: row.escalationReason,
    hasCustomerContact: row.customerContactEnc !== null,
  };
}

export function toAdminComplaintDetail(detail: ComplaintDetail) {
  return {
    ...toAdminComplaint(detail.complaint),
    messages: detail.messages.map((m) => ({
      ...toMessage(m.row),
      internal: m.row.internal,
      author: m.authorRef,
    })),
  };
}
