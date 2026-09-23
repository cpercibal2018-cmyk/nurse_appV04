// Workforce reference data. Commit 5 ships the two read-only lists the role
// assignment screens need (docs/API_MAP.md §2.4: readable by every signed-in
// user); create/update/deactivate, bed capacity and coverage targets arrive
// with the workforce commit (7).

import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authorize } from '../../middleware/authorize.js';

const UnitsQuery = z.object({
  departmentId: z.coerce.number().int().positive().optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
});

export function createWorkforceRouter(db: Db) {
  const router = Router();

  router.get('/departments', authorize('workforce.read'), async (_req, res) => {
    const items = await db.department.findMany({ orderBy: { code: 'asc' } });
    res.json({ items, total: items.length });
  });

  router.get('/units', authorize('workforce.read'), async (req, res) => {
    const q = UnitsQuery.parse(req.query);
    const items = await db.unit.findMany({
      where: { ...(q.departmentId ? { departmentId: q.departmentId } : {}), ...(q.includeInactive === 'true' ? {} : { isActive: true }) },
      orderBy: { code: 'asc' },
    });
    res.json({ items, total: items.length });
  });

  return router;
}
