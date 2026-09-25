// Shadow mode administration (spec §10.9, D-60): the eligibility logic versions,
// the disagreements a SHADOW version found, HR's decision on each, and the
// promotion (or retirement) of the SHADOW version. HR and System Admins read;
// only a system-wide HR Admin decides, promotes or retires — a new logic changes
// every nurse's eligibility. Every decision is audited HIGH.

import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { conflict, HttpError, notFound } from '../../lib/http-errors.js';
import { logger } from '../../lib/logger.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { unitScope, type AuthContext } from '../users/access.js';
import { ENGINES, promotionState, reevaluateAll } from './logic.js';
import { refreshEligibility } from './state.service.js';

const Reason = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000);
const VersionParam = z.object({ version: z.coerce.number().int().positive() });
const IdParam = z.object({ id: z.coerce.number().int().positive() });
export const FindingsQuery = z.object({
  decision: z.enum(['undecided', 'approved', 'rejected', 'all']).default('undecided'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export const DecisionBody = z.strictObject({ decision: z.enum(['APPROVED', 'REJECTED']), note: Reason });
export const LifecycleBody = z.strictObject({ reason: Reason });

const READ_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;

async function assertSystemHr(tx: DbClient, auth: AuthContext) {
  if (!(await unitScope(tx, auth, ['HR_ADMIN'])).all) {
    throw new HttpError(403, 'SCOPE_NOT_COVERED', 'Only a system-wide HR Admin decides on eligibility logic: it changes every nurse’s eligibility');
  }
}

export interface LogicRouterOptions {
  /** The re-evaluation after a promotion; tests limit it to their own nurses. Default: every live nurse. */
  reevaluate?: typeof reevaluateAll;
  /** Called when that re-evaluation has finished (tests wait on it). */
  onReevaluated?: (out: { done: number; failed: number }) => void;
}

export function createEligibilityLogicRouter(db: Db, opts: LogicRouterOptions = {}) {
  const r = Router();

  r.get('/eligibility/logic', authorize('eligibility.logic.read'), async (_req, res) => {
    const versions = await db.eligibilityLogicVersion.findMany({
      orderBy: { version: 'desc' },
      include: { promotedBy: { select: { id: true, displayName: true } }, retiredBy: { select: { id: true, displayName: true } } },
    });
    const shadow = versions.find((v) => v.status === 'SHADOW');
    res.json({
      active: versions.find((v) => v.status === 'ACTIVE')?.version ?? null,
      shadow: shadow ? { version: shadow.version, shadowSince: shadow.shadowSince, ...(await promotionState(db, shadow.version)) } : null,
      versions,
    });
  });

  r.get('/eligibility/logic/:version/findings', authorize('eligibility.logic.read'), async (req, res) => {
    const { version } = VersionParam.parse(req.params);
    const q = FindingsQuery.parse(req.query);
    const scope = await unitScope(db, authOf(res), READ_ROLES);
    const where = {
      logicVersion: version,
      ...(q.decision === 'undecided' ? { decision: null } : q.decision === 'all' ? {} : { decision: q.decision.toUpperCase() }),
      ...(scope.all ? {} : { employee: { unitId: { in: [...scope.unitIds] } } }),
    };
    const [items, total] = await Promise.all([
      db.eligibilityShadowLog.findMany({
        where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { employee: { select: { id: true, jobNumber: true, fullName: true, unitId: true } }, decidedBy: { select: { id: true, displayName: true } } },
      }),
      db.eligibilityShadowLog.count({ where }),
    ]);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  });

  r.post('/eligibility/logic/findings/:id/decision', authorize('eligibility.logic.review'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const body = DecisionBody.parse(req.body);
    const auth = authOf(res);
    const out = await db.$transaction(async (tx) => {
      await assertSystemHr(tx, auth);
      await tx.$queryRaw`SELECT id FROM eligibility_shadow_log WHERE id = ${id} FOR UPDATE`;
      const f = await tx.eligibilityShadowLog.findUnique({ where: { id }, include: { version: { select: { status: true } } } });
      if (!f) throw notFound('Finding not found');
      if (f.version.status !== 'SHADOW') throw conflict('LOGIC_NOT_IN_SHADOW', 'This version is no longer in shadow; its findings are closed');
      if (f.decision) throw conflict('FINDING_DECIDED', 'This finding was already decided');
      if (f.candidateStatus === 'ERROR' && body.decision === 'APPROVED') throw conflict('FINDING_IS_ERROR', 'The new logic failed here; a failure cannot be approved');
      const now = new Date();
      const saved = await tx.eligibilityShadowLog.update({ where: { id }, data: { decision: body.decision, decisionNote: body.note, decidedById: auth.user.id, decidedAt: now } });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'ELIGIBILITY_SHADOW_DECIDED', resource: 'eligibility_shadow_finding', resourceId: String(id),
        changes: { logicVersion: f.logicVersion, employeeId: f.employeeId, activeStatus: f.activeStatus, candidateStatus: f.candidateStatus, decision: body.decision, note: body.note },
        requestId: res.locals.requestId, priority: 'HIGH',
      });
      return saved;
    });
    res.json(out);
  });

  r.post('/eligibility/logic/:version/promote', authorize('eligibility.logic.promote'), async (req, res) => {
    const { version } = VersionParam.parse(req.params);
    const { reason } = LifecycleBody.parse(req.body);
    const auth = authOf(res);
    const previous = await db.$transaction(async (tx) => {
      await assertSystemHr(tx, auth);
      await tx.$queryRaw`SELECT version FROM eligibility_logic_versions FOR UPDATE`;
      if (!ENGINES.has(version)) throw conflict('LOGIC_NOT_SHIPPED', 'This release does not include that version of the eligibility logic');
      const state = await promotionState(tx, version);
      if (!state.promotable) throw conflict('LOGIC_NOT_PROMOTABLE', state.blocker ?? 'This version cannot be promoted', state);
      const now = new Date();
      const active = await tx.eligibilityLogicVersion.findFirst({ where: { status: 'ACTIVE' } });
      if (active) await tx.eligibilityLogicVersion.update({ where: { version: active.version }, data: { status: 'RETIRED', retiredAt: now, retiredById: auth.user.id } });
      await tx.eligibilityLogicVersion.update({ where: { version }, data: { status: 'ACTIVE', promotedAt: now, promotedById: auth.user.id, note: reason } });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'ELIGIBILITY_LOGIC_PROMOTED', resource: 'eligibility_logic', resourceId: String(version),
        changes: { from: active?.version ?? null, to: version, reason, daysInShadow: state.daysInShadow, findings: state.findings, approved: state.approved },
        requestId: res.locals.requestId, priority: 'HIGH',
      });
      return active?.version ?? null;
    });
    // Every stored state moves to the new logic now; the daily transition catches any miss.
    void (opts.reevaluate ?? reevaluateAll)(db, (tx, employeeId) => refreshEligibility(tx, employeeId, 'LOGIC_PROMOTED', { actorUserId: auth.user.id }))
      .then((out) => { logger.info('eligibility re-evaluated after promotion', { version, ...out }); opts.onReevaluated?.(out); });
    res.json({ active: version, retired: previous, reevaluation: 'started' });
  });

  r.post('/eligibility/logic/:version/retire', authorize('eligibility.logic.promote'), async (req, res) => {
    const { version } = VersionParam.parse(req.params);
    const { reason } = LifecycleBody.parse(req.body);
    const auth = authOf(res);
    await db.$transaction(async (tx) => {
      await assertSystemHr(tx, auth);
      const v = await tx.eligibilityLogicVersion.findUnique({ where: { version } });
      if (!v) throw notFound('Version not found');
      if (v.status !== 'SHADOW') throw conflict('LOGIC_NOT_IN_SHADOW', 'Only the version in shadow can be retired');
      await tx.eligibilityLogicVersion.update({ where: { version }, data: { status: 'RETIRED', retiredAt: new Date(), retiredById: auth.user.id, note: reason } });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'ELIGIBILITY_LOGIC_RETIRED', resource: 'eligibility_logic', resourceId: String(version),
        changes: { reason }, requestId: res.locals.requestId, priority: 'HIGH',
      });
    });
    res.json({ retired: version });
  });

  return r;
}
