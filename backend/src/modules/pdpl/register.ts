// Processing register (spec §8.3.2, D-54): the documented lawful basis, purpose
// and retention for each category of sensitive personal data. A sensitive
// value is stored only while its category has an active row (protection.ts).
// HR and System Admins read it; System Admins maintain it (audited HIGH).

import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';

const Basis = z.enum(['EMPLOYMENT_CONTRACT', 'LEGAL_OBLIGATION', 'CONSENT', 'VITAL_INTEREST', 'PUBLIC_INTEREST']);
const Reason = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000);
export const RegisterCreateBody = z.strictObject({
  dataCategory: z.enum(['IQAMA', 'PASSPORT', 'SCFHS_REG', 'IDENTITY_SCAN']),
  lawfulBasis: Basis,
  purpose: z.string().trim().min(10).max(1000),
  retentionRule: z.string().trim().min(5).max(500),
  reason: Reason,
});
export const RegisterUpdateBody = z.strictObject({
  purpose: z.string().trim().min(10).max(1000).optional(),
  retentionRule: z.string().trim().min(5).max(500).optional(),
  isActive: z.boolean().optional(),
  reason: Reason,
});
const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function createPdplRouter(db: Db) {
  const r = Router();

  r.get('/pdpl/register', authorize('pdpl.read'), async (_req, res) => {
    const items = await db.processingRegister.findMany({ orderBy: [{ dataCategory: 'asc' }, { lawfulBasis: 'asc' }] });
    res.json({ items, total: items.length });
  });

  r.post('/pdpl/register', authorize('pdpl.manage'), async (req, res) => {
    const { reason, ...body } = RegisterCreateBody.parse(req.body);
    const auth = authOf(res);
    const row = await db.$transaction(async (tx) => {
      const created = await tx.processingRegister.create({ data: { ...body, updatedById: auth.user.id } });
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'PROCESSING_REGISTER_ADDED', resource: 'processing_register', resourceId: created.id, changes: { ...body, reason }, requestId: res.locals.requestId, priority: 'HIGH' });
      return created;
    });
    res.status(201).json(row);
  });

  r.patch('/pdpl/register/:id', authorize('pdpl.manage'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const { reason, ...body } = RegisterUpdateBody.parse(req.body);
    const auth = authOf(res);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.processingRegister.findUnique({ where: { id } });
      if (!before) throw notFound('Register entry not found');
      const after = await tx.processingRegister.update({ where: { id }, data: { ...body, updatedById: auth.user.id } });
      const changed = Object.fromEntries(Object.entries(body).filter(([k, v]) => before[k as keyof typeof before] !== v).map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]));
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'PROCESSING_REGISTER_CHANGED', resource: 'processing_register', resourceId: id, changes: { dataCategory: before.dataCategory, changed, reason }, requestId: res.locals.requestId, priority: 'HIGH' });
      return after;
    });
    res.json(row);
  });

  return r;
}
