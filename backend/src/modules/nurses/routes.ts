// Employee master endpoints (docs/API_MAP.md §2.5). Scope and field views are
// decided in the service; the route only checks the permission.

import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { DeleteBody, ListQuery, OnboardBody, PositionBody, UpdateBody, type NurseService } from './service.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function createNursesRouter(db: Db, nurses: NurseService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  r.get('/employees', authorize('employees.read'), async (req, res) => { res.json(await nurses.list(authOf(res), ListQuery.parse(req.query))); });
  r.get('/employees/me', async (_req, res) => { res.json(await nurses.me(authOf(res))); });
  r.post('/employees/onboard', authorize('employees.write'), idempotent(db, 'employees.onboard'), async (req, res) => {
    res.status(201).json(await nurses.onboard(authOf(res), OnboardBody.parse(req.body), rid(res)));
  });
  // Own-or-scoped checks happen in the service.
  r.get('/employees/:id', async (req, res) => { res.json(await nurses.get(authOf(res), IdParam.parse(req.params).id)); });
  r.patch('/employees/:id', authorize('employees.write'), async (req, res) => {
    res.json(await nurses.update(authOf(res), IdParam.parse(req.params).id, UpdateBody.parse(req.body), rid(res)));
  });
  r.post('/employees/:id/position', authorize('employees.position'), async (req, res) => {
    res.json(await nurses.assignPosition(authOf(res), IdParam.parse(req.params).id, PositionBody.parse(req.body), rid(res)));
  });
  r.delete('/employees/:id', authorize('employees.write'), async (req, res) => {
    res.json(await nurses.remove(authOf(res), IdParam.parse(req.params).id, DeleteBody.parse(req.body).reason, rid(res)));
  });

  return r;
}
