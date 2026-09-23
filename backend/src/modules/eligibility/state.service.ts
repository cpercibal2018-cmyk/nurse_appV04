// Materialized eligibility (spec §6.1 "Materialized Eligibility State"; rule L6).
// Every handler that changes a contract, credential, requirement, position or
// waiver calls refreshEligibility(tx, …) INSIDE its own transaction, so the
// stored state commits with the change. Date passage (expiries, waiver ends,
// deadlines) is caught by the daily transition job (commit 9); publication
// never trusts this snapshot and re-runs the engine (L7).

import { appendAudit } from '../../lib/audit.js';
import { dbDate, riyadhDate, type IsoDate } from '../../lib/dates.js';
import type { DbClient } from '../../lib/prisma.js';
import { evaluate, type EngineFacts, type EngineResult } from './engine.js';

export async function loadFacts(tx: DbClient, employeeId: number, now: Date): Promise<EngineFacts> {
  const emp = await tx.employee.findUnique({
    where: { id: employeeId },
    include: {
      position: { select: { code: true, isSchedulable: true } },
      contracts: { select: { status: true, startDate: true, endDate: true } },
      credentials: {
        select: {
          id: true, templateId: true, status: true, issueDate: true, expiryDate: true, pendingData: true, graceCycleId: true,
          documents: { where: { reviewStatus: 'PENDING_REVIEW', scanStatus: { not: 'INFECTED' } }, select: { id: true } },
        },
      },
      waivers: { where: { expiresAt: { gt: now } }, select: { id: true, templateId: true, createdAt: true, expiresAt: true } },
    },
  });
  const requirements = emp?.unitId != null
    ? await tx.credentialRequirement.findMany({ where: { unitId: emp.unitId } })
    : [];
  const templateIds = [...new Set([...requirements.map((r) => r.templateId), ...(emp?.credentials.map((c) => c.templateId) ?? [])])];
  const templates = await tx.credentialTemplate.findMany({
    where: { id: { in: templateIds } },
    select: { id: true, code: true, name: true, hasExpiry: true, gracePeriodDays: true },
  });

  return {
    employee: emp && { id: emp.id, status: emp.status, deletedAt: emp.deletedAt, unitId: emp.unitId, positionCode: emp.positionCode },
    position: emp?.position ?? null,
    contracts: (emp?.contracts ?? []).map((c) => ({ status: c.status, startDate: dbDate(c.startDate), endDate: dbDate(c.endDate) })),
    requirements: requirements.map((r) => ({
      id: r.id, templateId: r.templateId, unitId: r.unitId, positionCode: r.positionCode, policyStatus: r.policyStatus,
      transitionDeadline: r.transitionDeadline ? dbDate(r.transitionDeadline) : null,
    })),
    templates: new Map(templates.map((t) => [t.id, t])),
    credentials: (emp?.credentials ?? []).map((c) => ({
      id: c.id, templateId: c.templateId, status: c.status,
      issueDate: c.issueDate ? dbDate(c.issueDate) : null, expiryDate: c.expiryDate ? dbDate(c.expiryDate) : null,
      renewalInProgress: c.pendingData !== null || c.documents.length > 0,
      graceCycleId: c.graceCycleId,
    })),
    waivers: emp?.waivers ?? [],
  };
}

/** Evaluates a nurse for a given day without storing anything (pool checks, publication, previews). */
export async function evaluateFor(tx: DbClient, employeeId: number, date: IsoDate, now = new Date()): Promise<EngineResult> {
  return evaluate(await loadFacts(tx, employeeId, now), { date, today: riyadhDate(now), now });
}

/**
 * Active HR admins whose scope covers a unit (system-wide, the unit's
 * department, or the unit itself) — recipients of eligibility notices (N2).
 */
export async function hrRecipientsForUnit(tx: DbClient, unitId: number | null, now = new Date()): Promise<number[]> {
  const unit = unitId === null ? null : await tx.unit.findUnique({ where: { id: unitId }, select: { departmentId: true } });
  const grants = await tx.roleAssignment.findMany({
    where: {
      role: 'HR_ADMIN', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], user: { isActive: true },
    },
    select: { userId: true, scopeType: true, scopeIds: true },
  });
  const ids = grants.filter((g) =>
    g.scopeType === 'SYSTEM'
    || (g.scopeType === 'UNIT' && unitId !== null && g.scopeIds.includes(unitId))
    || (g.scopeType === 'DEPARTMENT' && unit !== null && g.scopeIds.includes(unit.departmentId)),
  ).map((g) => g.userId);
  return [...new Set(ids)];
}

/** Recalculates and stores one nurse's eligibility for today, inside the caller's transaction. */
export async function refreshEligibility(tx: DbClient, employeeId: number, event: string, opts: { actorUserId?: number | null; requestId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const facts = await loadFacts(tx, employeeId, now);
  if (!facts.employee) return null;
  const result = evaluate(facts, { date: riyadhDate(now), today: riyadhDate(now), now });

  const previous = await tx.eligibilityState.findUnique({ where: { employeeId }, select: { status: true } });
  const data = { status: result.status, reasons: result.reasons as object[], calculatedAt: now, updatedByEvent: event, logicVersion: result.logicVersion };
  await tx.eligibilityState.upsert({ where: { employeeId }, update: data, create: { employeeId, ...data } });

  // L8: grace is never silent — record the first use of each grace window.
  for (const g of result.graceUsed) {
    const credential = facts.credentials.find((c) => c.id === g.credentialId);
    if (credential?.graceCycleId === g.cycleId) continue; // already recorded for this cycle
    await tx.credential.update({ where: { id: g.credentialId }, data: { graceActivatedAt: now, graceExpiryDate: new Date(`${g.graceEndDate}T00:00:00Z`), graceCycleId: g.cycleId } });
    await appendAudit(tx, {
      actorUserId: opts.actorUserId ?? null, action: 'GRACE_ACTIVATED', resource: 'credential', resourceId: g.credentialId,
      changes: { employeeId, templateId: g.templateId, graceEndDate: g.graceEndDate, cycleId: g.cycleId, event }, requestId: opts.requestId, priority: 'HIGH',
    });
    const tpl = facts.templates.get(g.templateId);
    const hr = await hrRecipientsForUnit(tx, facts.employee.unitId, now);
    const own = await tx.user.findFirst({ where: { employeeId, isActive: true }, select: { id: true } });
    const recipients = [...new Set([...hr, ...(own ? [own.id] : [])])];
    await tx.notification.createMany({
      data: recipients.map((recipientId) => ({
        recipientId, employeeId, type: 'ELIGIBILITY' as const, priority: 'HIGH' as const,
        title: recipientId === own?.id ? 'Renewal Required — Grace Period Active' : 'Grace period in use',
        message: `${tpl?.name ?? 'A credential'} has expired; a renewal is under review. Grace ends on ${g.graceEndDate}.`,
        titleAr: 'فترة السماح مفعلة', messageAr: `انتهت صلاحية ${tpl?.name ?? 'شهادة'}؛ التجديد قيد المراجعة. تنتهي فترة السماح في ${g.graceEndDate}.`,
        eventKey: `grace:${g.cycleId}`,
      })),
      skipDuplicates: true,
    });
  }

  if (previous?.status !== result.status) {
    await appendAudit(tx, {
      actorUserId: opts.actorUserId ?? null, action: 'ELIGIBILITY_CHANGED', resource: 'employee', resourceId: employeeId,
      changes: { from: previous?.status ?? null, to: result.status, reasons: result.reasons.map((r) => r.code), event }, requestId: opts.requestId,
    });
  }
  return result;
}

/** Refreshes every live employee of a unit (optionally one position) — after a requirement change. */
export async function refreshUnit(tx: DbClient, unitId: number, positionCode: string | null, event: string, opts: { actorUserId?: number | null; requestId?: string } = {}) {
  const emps = await tx.employee.findMany({
    where: { unitId, deletedAt: null, ...(positionCode ? { positionCode } : {}) },
    select: { id: true },
  });
  for (const e of emps) await refreshEligibility(tx, e.id, event, opts);
  return emps.length;
}
