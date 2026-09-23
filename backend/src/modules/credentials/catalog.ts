// Credential catalog (spec §5.1.1–5.1.3) and requirements (§5.1.4).
// Every requirement change re-evaluates the affected nurses in the same
// transaction (L6): "Adding a new mandatory requirement immediately affects
// eligibility for employees who lack that credential."

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { isIsoDate, toDbDate } from '../../lib/dates.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { refreshEligibility, refreshUnit } from '../eligibility/state.service.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { HR_ROLES } from './access.js';

const FieldType = z.enum(['text', 'date', 'date_hijri', 'select', 'number', 'country', 'reference']);
export const FieldDefSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
  label: z.string().trim().min(1).max(100),
  type: FieldType,
  required: z.boolean(),
  displayOrder: z.number().int().min(0),
  isIssueDate: z.boolean().optional(),
  isExpiryDate: z.boolean().optional(),
});
export type FieldDef = z.infer<typeof FieldDefSchema>;

const FieldDefs = z.array(FieldDefSchema).max(30).superRefine((defs, ctx) => {
  const keys = new Set<string>();
  for (const d of defs) {
    if (keys.has(d.key)) ctx.addIssue({ code: 'custom', message: `Duplicate field key ${d.key}` });
    keys.add(d.key);
    if ((d.isIssueDate || d.isExpiryDate) && d.type !== 'date') ctx.addIssue({ code: 'custom', message: `${d.key}: issue/expiry fields must be of type date` });
  }
  if (defs.filter((d) => d.isIssueDate).length > 1) ctx.addIssue({ code: 'custom', message: 'At most one issue-date field' });
  if (defs.filter((d) => d.isExpiryDate).length > 1) ctx.addIssue({ code: 'custom', message: 'At most one expiry-date field' });
});

export const TemplateCreateBody = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  name: z.string().trim().min(1).max(120),
  categoryCode: z.string().min(1),
  description: z.string().trim().max(500).optional(),
  hasExpiry: z.boolean().default(true),
  requiresUpload: z.boolean().default(true),
  fieldDefs: FieldDefs.default([]),
  /** Spec §6.1.1: 0–90 days, default 0; set by HR per hospital policy. */
  gracePeriodDays: z.number().int().min(0).max(90).default(0),
  displayOrder: z.number().int().min(0).default(0),
});
export const TemplateUpdateBody = TemplateCreateBody.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() }).strict();

const Policy = z.enum(['MANDATORY', 'TRANSITION', 'OPTIONAL']);
const RequirementFields = {
  templateId: z.number().int().positive(),
  unitId: z.number().int().positive(),
  positionCode: z.string().min(1).nullable().default(null),
  policyStatus: Policy.default('MANDATORY'),
  transitionDeadline: z.string().refine(isIsoDate, 'YYYY-MM-DD').nullable().default(null),
};
const checkDeadline = <T extends { policyStatus?: string; transitionDeadline?: string | null }>(r: T, ctx: z.RefinementCtx) => {
  if (r.policyStatus === 'TRANSITION' && !r.transitionDeadline) ctx.addIssue({ code: 'custom', path: ['transitionDeadline'], message: 'A TRANSITION requirement needs a transition deadline (spec §6.1.1.1)' });
  if (r.policyStatus && r.policyStatus !== 'TRANSITION' && r.transitionDeadline) ctx.addIssue({ code: 'custom', path: ['transitionDeadline'], message: 'Only TRANSITION requirements have a deadline' });
};
export const RequirementBody = z.strictObject(RequirementFields).superRefine(checkDeadline);
export const RequirementUpdateBody = z.strictObject({
  positionCode: RequirementFields.positionCode.optional(),
  policyStatus: Policy.optional(),
  transitionDeadline: RequirementFields.transitionDeadline.optional(),
}).superRefine(checkDeadline);
export const RequirementBulkBody = z.strictObject({ items: z.array(RequirementBody).min(1).max(500) });
export const RequirementQuery = z.object({
  unitId: z.coerce.number().int().positive().optional(),
  position: z.string().min(1).optional(),
  templateId: z.coerce.number().int().positive().optional(),
});

type RequirementInput = z.infer<typeof RequirementBody>;

export function createCatalogService(db: Db) {
  /** Templates are one hospital-wide catalog: only system-wide HR/System Admins may change them. */
  async function assertSystemWide(auth: AuthContext) {
    if (!(await unitScope(db, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the hospital credential catalog');
  }

  async function assertUnitInScope(tx: DbClient, auth: AuthContext, unitId: number) {
    const scope = await unitScope(tx, auth, HR_ROLES);
    if (!scope.all && !scope.unitIds.has(unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your assigned scope');
  }

  async function assertRequirementTargets(tx: DbClient, r: { templateId: number; unitId: number; positionCode: string | null }) {
    const [tpl, unit, pos] = await Promise.all([
      tx.credentialTemplate.findUnique({ where: { id: r.templateId }, select: { isActive: true } }),
      tx.unit.findUnique({ where: { id: r.unitId }, select: { id: true } }),
      r.positionCode ? tx.position.findUnique({ where: { code: r.positionCode }, select: { isActive: true } }) : Promise.resolve({ isActive: true }),
    ]);
    if (!tpl) throw new HttpError(422, 'TEMPLATE_NOT_FOUND', 'The credential template does not exist');
    if (!tpl.isActive) throw new HttpError(422, 'TEMPLATE_INACTIVE', 'The credential template is inactive');
    if (!unit) throw new HttpError(422, 'UNIT_NOT_FOUND', 'The unit does not exist');
    if (!pos) throw new HttpError(422, 'POSITION_NOT_FOUND', 'The position does not exist');
    if (!pos.isActive) throw new HttpError(422, 'POSITION_NOT_ACTIVE', 'The position is not active');
  }

  const toRow = (r: RequirementInput) => ({
    templateId: r.templateId, unitId: r.unitId, positionCode: r.positionCode, policyStatus: r.policyStatus,
    transitionDeadline: r.transitionDeadline ? toDbDate(r.transitionDeadline) : null,
  });

  return {
    listCategories: () => db.credentialCategory.findMany({ orderBy: { displayOrder: 'asc' } }),
    listTemplates: (includeInactive: boolean) => db.credentialTemplate.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: [{ categoryCode: 'asc' }, { displayOrder: 'asc' }] }),

    async createTemplate(auth: AuthContext, body: z.infer<typeof TemplateCreateBody>, requestId?: string) {
      await assertSystemWide(auth);
      if (!(await db.credentialCategory.findUnique({ where: { code: body.categoryCode } }))) throw new HttpError(422, 'CATEGORY_NOT_FOUND', 'The category does not exist');
      return db.$transaction(async (tx) => {
        const t = await tx.credentialTemplate.create({ data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'TEMPLATE_CREATED', resource: 'credential_template', resourceId: t.id, changes: body, requestId });
        return t;
      });
    },

    async updateTemplate(auth: AuthContext, id: number, body: z.infer<typeof TemplateUpdateBody>, requestId?: string) {
      await assertSystemWide(auth);
      const before = await db.credentialTemplate.findUnique({ where: { id } });
      if (!before) throw notFound('Template not found');
      return db.$transaction(async (tx) => {
        const t = await tx.credentialTemplate.update({ where: { id }, data: body });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'TEMPLATE_UPDATED', resource: 'credential_template', resourceId: id, changes: { before, after: body }, requestId });
        // Grace, expiry handling or activity changed: re-evaluate everyone who holds or needs it.
        if (body.gracePeriodDays !== undefined || body.hasExpiry !== undefined || body.isActive !== undefined) {
          const holders = await tx.credential.findMany({ where: { templateId: id }, select: { employeeId: true }, distinct: ['employeeId'] });
          for (const h of holders) await refreshEligibility(tx, h.employeeId, 'TEMPLATE_UPDATED', { actorUserId: auth.user.id, requestId });
        }
        return t;
      });
    },

    async listRequirements(q: z.infer<typeof RequirementQuery>) {
      const rows = await db.credentialRequirement.findMany({
        where: { ...(q.unitId ? { unitId: q.unitId } : {}), ...(q.position ? { positionCode: q.position } : {}), ...(q.templateId ? { templateId: q.templateId } : {}) },
        include: { template: { select: { code: true, name: true } }, unit: { select: { code: true, name: true } } },
        orderBy: [{ unitId: 'asc' }, { templateId: 'asc' }, { positionCode: 'asc' }],
      });
      return { items: rows, total: rows.length };
    },

    async createRequirement(auth: AuthContext, body: RequirementInput, requestId?: string) {
      return db.$transaction(async (tx) => {
        await assertUnitInScope(tx, auth, body.unitId);
        await assertRequirementTargets(tx, body);
        const r = await tx.credentialRequirement.create({ data: toRow(body) });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENT_CREATED', resource: 'credential_requirement', resourceId: r.id, changes: body, requestId, priority: 'HIGH' });
        const affected = await refreshUnit(tx, body.unitId, body.positionCode, 'REQUIREMENT_CREATED', { actorUserId: auth.user.id, requestId });
        return { ...r, affectedEmployees: affected };
      });
    },

    async updateRequirement(auth: AuthContext, id: number, body: z.infer<typeof RequirementUpdateBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const before = await tx.credentialRequirement.findUnique({ where: { id } });
        if (!before) throw notFound('Requirement not found');
        await assertUnitInScope(tx, auth, before.unitId);
        const next = {
          templateId: before.templateId, unitId: before.unitId,
          positionCode: body.positionCode !== undefined ? body.positionCode : before.positionCode,
          policyStatus: body.policyStatus ?? before.policyStatus,
          transitionDeadline: body.transitionDeadline !== undefined ? body.transitionDeadline : (before.transitionDeadline ? before.transitionDeadline.toISOString().slice(0, 10) : null),
        };
        if (next.policyStatus === 'TRANSITION' && !next.transitionDeadline) throw new HttpError(400, 'VALIDATION_FAILED', 'A TRANSITION requirement needs a transition deadline');
        if (next.policyStatus !== 'TRANSITION') next.transitionDeadline = null;
        await assertRequirementTargets(tx, next);
        const r = await tx.credentialRequirement.update({ where: { id }, data: toRow(next) });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENT_UPDATED', resource: 'credential_requirement', resourceId: id, changes: { before, after: next }, requestId, priority: 'HIGH' });
        // Old and new position scopes may differ: refresh the whole unit.
        const affected = await refreshUnit(tx, before.unitId, null, 'REQUIREMENT_UPDATED', { actorUserId: auth.user.id, requestId });
        return { ...r, affectedEmployees: affected };
      });
    },

    async deleteRequirement(auth: AuthContext, id: number, requestId?: string) {
      return db.$transaction(async (tx) => {
        const before = await tx.credentialRequirement.findUnique({ where: { id } });
        if (!before) throw notFound('Requirement not found');
        await assertUnitInScope(tx, auth, before.unitId);
        // Deleting a rule never deletes credentials employees hold (§5.1.4).
        await tx.credentialRequirement.delete({ where: { id } });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENT_DELETED', resource: 'credential_requirement', resourceId: id, changes: { before }, requestId, priority: 'HIGH' });
        const affected = await refreshUnit(tx, before.unitId, before.positionCode, 'REQUIREMENT_DELETED', { actorUserId: auth.user.id, requestId });
        return { id, affectedEmployees: affected };
      });
    },

    /** §5.1.4 bulk set: all entries in one transaction (initial hospital configuration). */
    async bulkSetRequirements(auth: AuthContext, items: RequirementInput[], requestId?: string) {
      return db.$transaction(async (tx) => {
        const units = new Set<number>();
        let created = 0;
        let updated = 0;
        for (const item of items) {
          await assertUnitInScope(tx, auth, item.unitId);
          await assertRequirementTargets(tx, item);
          const existing = await tx.credentialRequirement.findFirst({ where: { templateId: item.templateId, unitId: item.unitId, positionCode: item.positionCode } });
          if (existing) { await tx.credentialRequirement.update({ where: { id: existing.id }, data: toRow(item) }); updated++; }
          else { await tx.credentialRequirement.create({ data: toRow(item) }); created++; }
          units.add(item.unitId);
        }
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'REQUIREMENTS_BULK_SET', resource: 'credential_requirement', changes: { created, updated, items }, requestId, priority: 'HIGH' });
        let affected = 0;
        for (const u of units) affected += await refreshUnit(tx, u, null, 'REQUIREMENTS_BULK_SET', { actorUserId: auth.user.id, requestId });
        return { created, updated, affectedEmployees: affected };
      }, { timeout: 60_000 });
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
