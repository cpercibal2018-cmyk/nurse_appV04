// Workforce: departments, units, bed capacity, positions, coverage targets and
// the nurse-to-bed KPI (docs/API_MAP.md §2.4; rules W1–W8).

import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { KpiQuery, nurseToBed } from './kpi.js';
import {
  BedCountBody, BulkBedsBody, CoverageBody, CoverageQuery, DepartmentCreateBody, DepartmentUpdateBody, ImportBody,
  PositionCreateBody, PositionUpdateBody, UnitCreateBody, UnitsQuery, UnitUpdateBody, type OrgService,
} from './org.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const CodeParam = z.object({ code: z.string().min(1).max(20) });
const InactiveQuery = z.object({ includeInactive: z.enum(['true', 'false']).default('false') });

export function createWorkforceRouter(db: Db, org: OrgService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  // ── Departments (W1) ──
  r.get('/departments', authorize('workforce.read'), async (req, res) => {
    res.json(await org.listDepartments(InactiveQuery.parse(req.query).includeInactive === 'true'));
  });
  r.post('/departments', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await org.createDepartment(authOf(res), DepartmentCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/departments/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await org.updateDepartment(authOf(res), IdParam.parse(req.params).id, DepartmentUpdateBody.parse(req.body), rid(res)));
  });

  // ── Units and beds (W2–W5). Literal paths before /units/:id. ──
  r.get('/units', authorize('workforce.read'), async (req, res) => { res.json(await org.listUnits(UnitsQuery.parse(req.query))); });
  r.get('/units/summary', authorize('workforce.read'), async (_req, res) => { res.json(await org.summary()); });
  r.put('/units/bed-capacity/bulk', authorize('workforce.write'), idempotent(db, 'units.beds.bulk'), async (req, res) => {
    res.json(await org.bulkBeds(authOf(res), BulkBedsBody.parse(req.body), rid(res)));
  });
  r.post('/units/import', authorize('workforce.write'), idempotent(db, 'units.import'), async (req, res) => {
    res.json(await org.importUnits(authOf(res), ImportBody.parse(req.body), rid(res)));
  });
  r.post('/units', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await org.createUnit(authOf(res), UnitCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/units/:id', authorize('workforce.write'), async (req, res) => {
    res.json(await org.updateUnit(authOf(res), IdParam.parse(req.params).id, UnitUpdateBody.parse(req.body), rid(res)));
  });
  r.put('/units/:id/bed-capacity', authorize('workforce.write'), async (req, res) => {
    res.json(await org.setBedCount(authOf(res), IdParam.parse(req.params).id, BedCountBody.parse(req.body), rid(res)));
  });
  r.get('/units/:id/bed-history', authorize('workforce.bedHistory'), async (req, res) => {
    res.json(await org.bedHistory(authOf(res), IdParam.parse(req.params).id));
  });

  // ── Positions (§3.1.1, W6, W7) ──
  r.get('/positions', authorize('workforce.read'), async (req, res) => {
    res.json(await org.listPositions(InactiveQuery.parse(req.query).includeInactive === 'true'));
  });
  r.get('/positions/:code', authorize('workforce.read'), async (req, res) => { res.json(await org.getPosition(CodeParam.parse(req.params).code)); });
  r.post('/positions', authorize('workforce.write'), async (req, res) => {
    res.status(201).json(await org.createPosition(authOf(res), PositionCreateBody.parse(req.body), rid(res)));
  });
  r.patch('/positions/:code', authorize('workforce.write'), async (req, res) => {
    res.json(await org.updatePosition(authOf(res), CodeParam.parse(req.params).code, PositionUpdateBody.parse(req.body), rid(res)));
  });

  // ── Coverage targets (§6.3, W8) ──
  r.get('/coverage-targets', authorize('workforce.read'), async (req, res) => { res.json(await org.listCoverage(CoverageQuery.parse(req.query))); });
  r.put('/coverage-targets', authorize('workforce.write'), async (req, res) => {
    res.json(await org.setCoverage(authOf(res), CoverageBody.parse(req.body), rid(res)));
  });

  // ── KPI (D-11) ──
  r.get('/kpi/nurse-to-bed', authorize('kpi.read'), async (req, res) => { res.json(await nurseToBed(db, KpiQuery.parse(req.query))); });

  return r;
}
