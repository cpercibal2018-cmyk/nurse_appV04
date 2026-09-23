// Roster and attendance endpoints (docs/API_MAP.md §2.9, §2.10). Scope,
// home-unit and eligibility rules live in the services.

import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { EventsQuery, GapsQuery, OwnEventsQuery, type AttendanceService } from '../attendance/service.js';
import { BoardQuery, CancelBody, CreateBody, GenerateBody, OwnQuery, PoolQuery, PublishBody, type SchedulingService } from './service.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export function createSchedulingRouter(db: Db, roster: SchedulingService, attendance: AttendanceService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  r.get('/roster', authorize('roster.read'), async (req, res) => { res.json(await roster.board(authOf(res), BoardQuery.parse(req.query))); });
  r.get('/roster/me', async (req, res) => { res.json(await roster.own(authOf(res), OwnQuery.parse(req.query))); });
  r.get('/roster/pool', authorize('roster.write'), async (req, res) => { res.json(await roster.pool(authOf(res), PoolQuery.parse(req.query))); });
  r.post('/roster/auto-generate', authorize('roster.write'), async (req, res) => {
    res.json(await roster.generate(authOf(res), GenerateBody.parse(req.body), rid(res)));
  });
  r.post('/roster/publish', authorize('roster.write'), idempotent(db, 'roster.publish'), async (req, res) => {
    res.json(await roster.publish(authOf(res), PublishBody.parse(req.body), rid(res)));
  });
  r.get('/coverage', authorize('roster.read'), async (req, res) => { res.json(await roster.coverage(authOf(res), BoardQuery.parse(req.query))); });
  r.post('/shift-assignments', authorize('roster.write'), async (req, res) => {
    res.status(201).json(await roster.create(authOf(res), CreateBody.parse(req.body), rid(res)));
  });
  r.delete('/shift-assignments/:id', authorize('roster.write'), async (req, res) => {
    res.json(await roster.remove(authOf(res), IdParam.parse(req.params).id, CancelBody.parse(req.body ?? {}).reason, rid(res)));
  });

  r.get('/attendance/events', authorize('attendance.read'), async (req, res) => { res.json(await attendance.events(authOf(res), EventsQuery.parse(req.query))); });
  r.get('/attendance/me', async (req, res) => { res.json(await attendance.own(authOf(res), OwnEventsQuery.parse(req.query))); });
  r.get('/attendance/gaps', authorize('attendance.read'), async (req, res) => { res.json(await attendance.gaps(authOf(res), GapsQuery.parse(req.query))); });

  return r;
}
