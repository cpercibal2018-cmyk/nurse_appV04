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
 * Active holders of a role whose scope covers a unit (system-wide, the unit's
 * department, or the unit itself) — recipients of unit notices (N2).
 */
export async function recipientsForUnit(tx: DbClient, role: 'HR_ADMIN' | 'SUPERVISOR', unitId: number | null, now = new Date()): Promise<number[]> {
  const unit = unitId === null ? null : await tx.unit.findUnique({ where: { id: unitId }, select: { departmentId: true } });
  const grants = await tx.roleAssignment.findMany({
    where: {
      role, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], user: { isActive: true },
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

export const hrRecipientsForUnit = (tx: DbClient, unitId: number | null, now = new Date()) => recipientsForUnit(tx, 'HR_ADMIN', unitId, now);

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

  await demoteInvalidPublished(tx, facts, employeeId, event, opts, now);

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

/**
 * Spec §6.2: a change to credentials, contract, employee status/position or
 * requirements rechecks the nurse's future published shifts. A shift the
 * engine now blocks — or one outside the nurse's home unit (D-32) — goes back
 * to Draft for review, with a HIGH audit row and a notice to the unit's
 * supervisors. Date passage is handled by the daily job (commit 9).
 */
async function demoteInvalidPublished(
  tx: DbClient, facts: EngineFacts, employeeId: number, event: string,
  opts: { actorUserId?: number | null; requestId?: string }, now: Date,
) {
  const today = riyadhDate(now);
  const published = await tx.shiftAssignment.findMany({
    where: { employeeId, status: 'Published', shiftDate: { gte: new Date(`${today}T00:00:00Z`) } },
    orderBy: { shiftDate: 'asc' },
  });
  for (const a of published) {
    const date = dbDate(a.shiftDate);
    const result = evaluate(facts, { date, today, now });
    const reasons: string[] = result.status === 'INELIGIBLE' ? result.reasons.filter((r) => r.severity === 'BLOCK').map((r) => r.code) : [];
    if (facts.employee?.unitId !== a.unitId) reasons.push('NOT_HOME_UNIT');
    if (reasons.length === 0) continue;
    await tx.shiftAssignment.update({ where: { id: a.id }, data: { status: 'Draft', publishedAt: null, publishedById: null, eligibilityAtPublish: null } });
    await appendAudit(tx, {
      actorUserId: opts.actorUserId ?? null, action: 'ASSIGNMENT_DEMOTED', resource: 'shift_assignment', resourceId: a.id,
      changes: { employeeId, unitId: a.unitId, shiftDate: date, shiftType: a.shiftType, reasons, event }, requestId: opts.requestId, priority: 'HIGH',
    });
    const supervisors = await recipientsForUnit(tx, 'SUPERVISOR', a.unitId, now);
    await tx.notification.createMany({
      data: supervisors.map((recipientId) => ({
        recipientId, employeeId, type: 'COVERAGE' as const, priority: 'HIGH' as const,
        title: 'Published shift returned to draft',
        message: `A ${a.shiftType} shift on ${date} no longer passes the eligibility check (${reasons.join(', ')}) and is back in draft for review.`,
        titleAr: 'أعيدت مناوبة منشورة إلى المسودة',
        messageAr: `المناوبة (${a.shiftType}) بتاريخ ${date} لم تعد تجتاز فحص الأهلية (${reasons.join('، ')}) وأعيدت إلى المسودة للمراجعة.`,
        eventKey: `demoted:${a.id}:${a.publishedAt?.getTime() ?? 0}`,
      })),
      skipDuplicates: true,
    });
  }
}
