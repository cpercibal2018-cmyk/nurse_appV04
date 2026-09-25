// Audit trail and background jobs for System Admins (decision D-20: audit
// reading is SA only until the hospital decides otherwise; spec §9.1).
// Audit ids are BIGINT: sent as strings so no client loses precision.

import { Router } from 'express';
import { z } from 'zod';
import { findChainBreaks } from '../../lib/audit.js';
import { isIsoDate } from '../../lib/dates.js';
import { notFound } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { appendAudit } from '../../lib/audit.js';
import { JOBS, runNow } from '../../jobs/scheduler.js';
import { businessHealth, type KeyStatus } from './business-health.js';

const IsoDate = z.string().refine(isIsoDate, 'YYYY-MM-DD');
const AuditQuery = z.object({
  resource: z.string().min(1).max(60).optional(),
  resourceId: z.string().min(1).max(60).optional(),
  actor: z.coerce.number().int().positive().optional(),
  action: z.string().min(1).max(80).optional(),
  priority: z.enum(['NORMAL', 'HIGH']).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const JobParam = z.object({ name: z.string().min(1).max(60) });
const RequestLogQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  actor: z.coerce.number().int().positive().optional(),
  requestId: z.string().min(1).max(128).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  /** A class ("4xx") or one code ("403"). */
  status: z.string().regex(/^[1-5](xx|\d\d)$/).optional(),
  path: z.string().min(1).max(200).optional(),
  errorCode: z.string().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
/** Riyadh calendar days → [from 00:00, day after `to` 00:00). */
const dayRange = (from?: string, to?: string) => (from || to ? {
  ...(from ? { gte: new Date(`${from}T00:00:00+03:00`) } : {}),
  ...(to ? { lt: new Date(new Date(`${to}T00:00:00+03:00`).getTime() + 86_400_000) } : {}),
} : undefined);

export function createAuditRouter(db: Db, keyStatus?: KeyStatus) {
  const r = Router();

  r.get('/audit', authorize('audit.read'), async (req, res) => {
    const q = AuditQuery.parse(req.query);
    const where = {
      ...(q.resource ? { resource: q.resource } : {}),
      ...(q.resourceId ? { resourceId: q.resourceId } : {}),
      ...(q.actor ? { actorUserId: q.actor } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00+03:00`) } : {}), ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00+03:00`).getTime() + 86_400_000) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      db.auditEntry.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.auditEntry.count({ where }),
    ]);
    const actors = await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((x) => (x.actorUserId ? [x.actorUserId] : [])))] } }, select: { id: true, displayName: true } });
    const name = new Map(actors.map((a) => [a.id, a.displayName]));
    res.json({
      items: rows.map((x) => ({ ...x, id: x.id.toString(), actorName: x.actorUserId ? name.get(x.actorUserId) ?? null : null })),
      total, page: q.page, pageSize: q.pageSize,
    });
  });

  /** Spec §9.2: the request-level forensic log, newest first. */
  r.get('/audit/requests', authorize('audit.read'), async (req, res) => {
    const q = RequestLogQuery.parse(req.query);
    const status = q.status
      ? q.status.endsWith('xx') ? { gte: Number(q.status[0]) * 100, lt: Number(q.status[0]) * 100 + 100 } : Number(q.status)
      : undefined;
    const at = dayRange(q.from, q.to);
    const where = {
      ...(at ? { at } : {}),
      ...(q.actor ? { actorUserId: q.actor } : {}),
      ...(q.requestId ? { requestId: q.requestId } : {}),
      ...(q.method ? { method: q.method } : {}),
      ...(status !== undefined ? { statusCode: status } : {}),
      ...(q.path ? { path: { contains: q.path } } : {}),
      ...(q.errorCode ? { errorCode: q.errorCode } : {}),
    };
    const [rows, total] = await Promise.all([
      db.requestLogEntry.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.requestLogEntry.count({ where }),
    ]);
    const actors = await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((x) => (x.actorUserId ? [x.actorUserId] : [])))] } }, select: { id: true, displayName: true } });
    const name = new Map(actors.map((a) => [a.id, a.displayName]));
    res.json({
      items: rows.map((x) => ({ ...x, id: x.id.toString(), actorName: x.actorUserId ? name.get(x.actorUserId) ?? null : null })),
      total, page: q.page, pageSize: q.pageSize,
    });
  });

  /** A3: recomputes every link and content hash in the database view. */
  r.get('/audit/verify', authorize('audit.read'), async (_req, res) => {
    const breaks = await findChainBreaks(db);
    res.json({ intact: breaks.length === 0, breaks: breaks.slice(0, 100).map((b) => ({ id: b.id.toString(), reason: b.reason })), checkedAt: new Date() });
  });

  r.get('/admin/jobs', authorize('jobs.read'), async (_req, res) => {
    const items = [];
    for (const job of JOBS) {
      const runs = await db.jobRun.findMany({ where: { jobName: job.name }, orderBy: { startedAt: 'desc' }, take: 10 });
      items.push({ name: job.name, schedule: job.schedule, runs });
    }
    res.json({ items });
  });

  // Spec §10.8: business health — eligibility drift, job freshness, e-mail delivery.
  r.get('/system/health/business', authorize('jobs.read'), async (_req, res) => {
    res.json(await businessHealth(db, new Date(), keyStatus));
  });

  r.post('/admin/jobs/:name/run', authorize('jobs.run'), async (req, res) => {
    const auth = authOf(res);
    const { name } = JobParam.parse(req.params);
    const out = await runNow(db, name);
    if (!out) throw notFound('No such job');
    await appendAudit(db, { actorUserId: auth.user.id, action: 'JOB_RUN_MANUALLY', resource: 'job', resourceId: name, changes: { runKey: out.runKey, status: out.status }, requestId: res.locals.requestId, priority: 'HIGH' });
    res.json(out);
  });

  return r;
}
