// Credential catalog (spec §5.1.1–5.1.3) and requirements (§5.1.4).
// Every requirement change re-evaluates the affected nurses in the same
// transaction (L6): "Adding a new mandatory requirement immediately affects
// eligibility for employees who lack that credential."

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { isIsoDate, toDbDate } from '../../lib/dates.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import { Prisma, type Db, type DbClient } from '../../lib/prisma.js';
import { refreshEligibility, refreshUnit } from '../eligibility/state.service.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { HR_ROLES, REVIEW_ROLES } from './access.js';
import { canonicalField, fieldRows, presentTemplate, WITH_FIELDS, type TemplateView } from './fields.js';

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
    if ((d.isIssueDate || d.isExpiryDate) && d.type !== 'date' && d.type !== 'date_hijri') {
      ctx.addIssue({ code: 'custom', message: `${d.key}: issue/expiry fields must be Gregorian or Umm al-Qura dates` });
    }
  }
  if (defs.filter((d) => d.isIssueDate).length > 1) ctx.addIssue({ code: 'custom', message: 'At most one issue-date field' });
  if (defs.filter((d) => d.isExpiryDate).length > 1) ctx.addIssue({ code: 'custom', message: 'At most one expiry-date field' });
}).transform((defs) => defs.map(canonicalField)); // same shape as stored rows, so comparisons are exact

/** Every catalog change goes to a second administrator (D-24), who needs to know why. */
const ChangeReason = z.string().trim().min(10, 'A catalog change needs a reason of at least 10 characters').max(1000);
const Name = z.string().trim().min(1).max(120);
const Description = z.string().trim().max(500);
/** Spec §6.1.1: 0–90 days, default 0; set by HR per hospital policy. */
const GraceDays = z.number().int().min(0).max(90);
const DisplayOrder = z.number().int().min(0);

export const TemplateCreateBody = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  name: Name,
  categoryCode: z.string().min(1),
  description: Description.optional(),
  hasExpiry: z.boolean().default(true),
  requiresUpload: z.boolean().default(true),
  fieldDefs: FieldDefs.default([]),
  gracePeriodDays: GraceDays.default(0),
  displayOrder: DisplayOrder.default(0),
  reason: ChangeReason,
});
// Written out without defaults: `.partial()` of a schema with defaults would
// fill every omitted field with its default and overwrite the stored value.
export const TemplateUpdateBody = z.strictObject({
  name: Name.optional(),
  categoryCode: z.string().min(1).optional(),
  description: Description.optional(),
  hasExpiry: z.boolean().optional(),
  requiresUpload: z.boolean().optional(),
  fieldDefs: FieldDefs.optional(),
  gracePeriodDays: GraceDays.optional(),
  displayOrder: DisplayOrder.optional(),
  isActive: z.boolean().optional(),
  reason: ChangeReason,
});

type TemplateData = Omit<z.infer<typeof TemplateCreateBody>, 'reason'>;
type TemplateChange = Omit<z.infer<typeof TemplateUpdateBody>, 'reason'>;
type ChangedValues = Partial<Record<keyof TemplateChange, unknown>>;

/** Stored in approval_requests.payload for catalog changes (R10, D-24). */
export type CatalogApprovalPayload =
  | { kind: 'TEMPLATE_CREATE'; template: TemplateData; reason: string }
  /** `before` holds the stored values of the changed fields, to refuse a stale approval. */
  | { kind: 'TEMPLATE_UPDATE'; templateId: number; code: string; change: TemplateChange; before: ChangedValues; reason: string };

export type CatalogOutcome = { status: 'APPLIED'; template: TemplateView } | { status: 'PENDING_APPROVAL'; requestId: number };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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
  /** Templates are one hospital-wide catalog: only system-wide HR/System Admins may change them (D-25). */
  async function assertSystemWide(tx: DbClient, auth: AuthContext) {
    if (!(await unitScope(tx, auth, HR_ROLES)).all) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only system-wide administrators can change the hospital credential catalog');
  }

  async function validateCreate(tx: DbClient, t: TemplateData) {
    if (!(await tx.credentialCategory.findUnique({ where: { code: t.categoryCode } }))) throw new HttpError(422, 'CATEGORY_NOT_FOUND', 'The category does not exist');
    if (await tx.credentialTemplate.findUnique({ where: { code: t.code }, select: { id: true } })) throw new HttpError(409, 'TEMPLATE_EXISTS', `A credential type with code ${t.code} already exists`);
  }

  async function loadTemplate(tx: DbClient, id: number): Promise<TemplateView | null> {
    const t = await tx.credentialTemplate.findUnique({ where: { id }, include: WITH_FIELDS });
    return t ? presentTemplate(t) : null;
  }

  /** The fields the change really alters, with their stored values. */
  async function changedFields(tx: DbClient, id: number, change: TemplateChange) {
    const current = await loadTemplate(tx, id);
    if (!current) throw notFound('Template not found');
    const before: ChangedValues = {};
    for (const [k, v] of Object.entries(change) as Array<[keyof TemplateChange, unknown]>) {
      if (v !== undefined && !same(current[k], v)) before[k] = current[k];
    }
    if (Object.keys(before).length === 0) throw new HttpError(400, 'NO_CHANGES', 'The request does not change the credential type');
    if (change.categoryCode && before.categoryCode !== undefined && !(await tx.credentialCategory.findUnique({ where: { code: change.categoryCode } }))) {
      throw new HttpError(422, 'CATEGORY_NOT_FOUND', 'The category does not exist');
    }
    return { current, before };
  }

  async function createNow(tx: DbClient, auth: AuthContext, t: TemplateData, reason: string, approvalRequestId: number | null, requestId?: string) {
    await assertSystemWide(tx, auth);
    await validateCreate(tx, t);
    const { fieldDefs, ...columns } = t;
    const created = await tx.credentialTemplate.create({ data: columns });
    await tx.credentialTemplateField.createMany({ data: fieldRows(created.id, fieldDefs) });
    const row = (await loadTemplate(tx, created.id))!;
    await appendAudit(tx, { actorUserId: auth.user.id, action: 'TEMPLATE_CREATED', resource: 'credential_template', resourceId: row.id, changes: { template: t, reason, approvalRequestId }, requestId, priority: 'HIGH' });
    return row;
  }

  /** `expected` (from the approval request) must still match, or the approver would sign off on values nobody saw. */
  async function updateNow(tx: DbClient, auth: AuthContext, id: number, change: TemplateChange, reason: string, expected: ChangedValues | null, approvalRequestId: number | null, requestId?: string) {
    await assertSystemWide(tx, auth);
    const { current, before } = await changedFields(tx, id, change);
    if (expected) {
      for (const [k, v] of Object.entries(expected) as Array<[keyof TemplateChange, unknown]>) {
        if (!same(current[k], v)) throw new HttpError(409, 'TEMPLATE_CHANGED_SINCE_REQUEST', 'The credential type has changed since this request was made — reject it and submit a new one');
      }
    }
    const { fieldDefs, ...columns } = change;
    if (Object.keys(columns).length) await tx.credentialTemplate.update({ where: { id }, data: columns });
    // Field definitions are replaced as a set; the audit entry keeps before → after.
    if (fieldDefs !== undefined) {
      await tx.credentialTemplateField.deleteMany({ where: { templateId: id } });
      await tx.credentialTemplateField.createMany({ data: fieldRows(id, fieldDefs) });
    }
    const row = (await loadTemplate(tx, id))!;
    await appendAudit(tx, { actorUserId: auth.user.id, action: 'TEMPLATE_UPDATED', resource: 'credential_template', resourceId: id, changes: { before, after: change, reason, approvalRequestId }, requestId, priority: 'HIGH' });
    // Grace, expiry handling or activity changed: re-evaluate everyone who holds it.
    if (change.gracePeriodDays !== undefined || change.hasExpiry !== undefined || change.isActive !== undefined) {
      const holders = await tx.credential.findMany({ where: { templateId: id }, select: { employeeId: true }, distinct: ['employeeId'] });
      for (const h of holders) await refreshEligibility(tx, h.employeeId, 'TEMPLATE_UPDATED', { actorUserId: auth.user.id, requestId });
    }
    return row;
  }

  async function initiateApproval(auth: AuthContext, actionType: string, payload: CatalogApprovalPayload, requestId?: string) {
    return db.$transaction(async (tx) => {
      const req = await tx.approvalRequest.create({ data: { initiatorId: auth.user.id, actionType, payload: payload as Prisma.InputJsonObject } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'APPROVAL_INITIATED', resource: 'approval_request', resourceId: req.id, changes: { actionType, payload }, requestId, priority: 'HIGH' });
      return req.id;
    });
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
    listTemplates: async (includeInactive: boolean) => (await db.credentialTemplate.findMany({
      where: includeInactive ? {} : { isActive: true }, orderBy: [{ categoryCode: 'asc' }, { displayOrder: 'asc' }], include: WITH_FIELDS,
    })).map(presentTemplate),

    // R10 as decided in D-24: every catalog change needs a second system-wide
    // administrator. Break-glass bypasses four-eyes (spec §3.6), as for roles.
    async createTemplate(auth: AuthContext, body: z.infer<typeof TemplateCreateBody>, requestId?: string): Promise<CatalogOutcome> {
      const { reason, ...template } = body;
      if (auth.breakGlass) return { status: 'APPLIED', template: await db.$transaction((tx) => createNow(tx, auth, template, reason, null, requestId)) };
      // Validate now so an impossible request never reaches the approval queue.
      await assertSystemWide(db, auth);
      await validateCreate(db, template);
      return { status: 'PENDING_APPROVAL', requestId: await initiateApproval(auth, `TEMPLATE_CREATE:${template.code}`, { kind: 'TEMPLATE_CREATE', template, reason }, requestId) };
    },

    async updateTemplate(auth: AuthContext, id: number, body: z.infer<typeof TemplateUpdateBody>, requestId?: string): Promise<CatalogOutcome> {
      const { reason, ...change } = body;
      if (auth.breakGlass) return { status: 'APPLIED', template: await db.$transaction((tx) => updateNow(tx, auth, id, change, reason, null, null, requestId)) };
      await assertSystemWide(db, auth);
      const { current, before } = await changedFields(db, id, change);
      const only = Object.fromEntries(Object.keys(before).map((k) => [k, change[k as keyof TemplateChange]])) as TemplateChange;
      return { status: 'PENDING_APPROVAL', requestId: await initiateApproval(auth, `TEMPLATE_UPDATE:${id}`, { kind: 'TEMPLATE_UPDATE', templateId: id, code: current.code, change: only, before, reason }, requestId) };
    },

    /** Executes an approved catalog request as the approver, inside the approval's transaction (R11). */
    async executeApproved(tx: DbClient, approver: AuthContext, payload: CatalogApprovalPayload, approvalRequestId: number, requestId?: string) {
      if (payload.kind === 'TEMPLATE_CREATE') return (await createNow(tx, approver, payload.template, payload.reason, approvalRequestId, requestId)).id;
      return (await updateNow(tx, approver, payload.templateId, payload.change, payload.reason, payload.before, approvalRequestId, requestId)).id;
    },

    async listRequirements(auth: AuthContext, q: z.infer<typeof RequirementQuery>) {
      const scope = await unitScope(db, auth, REVIEW_ROLES);
      // The caller's unit scope must constrain even an explicitly requested
      // unitId; otherwise a supervisor could read the hospital's other rules.
      if (q.unitId && !scope.all && !scope.unitIds.has(q.unitId)) return { items: [], total: 0 };
      const unitId = q.unitId ?? (scope.all ? undefined : { in: [...scope.unitIds] });
      const rows = await db.credentialRequirement.findMany({
        where: { ...(unitId === undefined ? {} : { unitId }), ...(q.position ? { positionCode: q.position } : {}), ...(q.templateId ? { templateId: q.templateId } : {}) },
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
