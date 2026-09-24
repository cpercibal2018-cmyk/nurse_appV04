// Consistency auditor (spec §10.8, "anti-drift"). Daily at 03:00 Riyadh — after
// the 00:05 date transition — it re-runs the full eligibility engine for a
// random sample of the workforce and compares the result with the stored
// eligibility state that scheduling reads. A difference in status or in the
// reason codes, or a missing state row, is drift: it is logged in
// consistency_audit_log, corrected at once (refreshEligibility), audited HIGH,
// and System Admins get one in-app summary per day.
//
// Sample: the spec's 1% of the workforce, but at least MIN_SAMPLE a day (1% of
// a few hundred nurses would check almost nobody), and everyone when smaller.

import { appendAudit } from '../lib/audit.js';
import { riyadhDate } from '../lib/dates.js';
import type { Db } from '../lib/prisma.js';
import { evaluate, type Reason } from '../modules/eligibility/engine.js';
import { loadFacts, refreshEligibility } from '../modules/eligibility/state.service.js';

export const MIN_SAMPLE = 50;
export const SAMPLE_FRACTION = 0.01;

export function sampleSize(population: number) {
  if (population <= MIN_SAMPLE) return population;
  return Math.max(MIN_SAMPLE, Math.ceil(population * SAMPLE_FRACTION));
}

/** What the comparison looks at: status plus each reason's code and credential type (messages carry dates, so not compared). */
const reasonKeys = (reasons: Array<Pick<Reason, 'code' | 'templateId'>>) => reasons.map((r) => `${r.code}:${r.templateId ?? ''}`).sort();
const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

export interface AuditOutcome { checked: number; drifted: number; missingState: number; driftedEmployeeIds: number[] }

/** Audits the given employees now; exported for "run now" and tests. */
export async function auditEmployees(db: Db, employeeIds: number[], now = new Date()): Promise<AuditOutcome> {
  const today = riyadhDate(now);
  const out: AuditOutcome = { checked: 0, drifted: 0, missingState: 0, driftedEmployeeIds: [] };
  for (const employeeId of employeeIds) {
    await db.$transaction(async (tx) => {
      // Hold the state row so a concurrent refresh cannot interleave with the comparison.
      await tx.$queryRaw`SELECT employee_id FROM eligibility_states WHERE employee_id = ${employeeId} FOR UPDATE`;
      const facts = await loadFacts(tx, employeeId, now);
      if (!facts.employee) return;
      out.checked++;
      const expected = evaluate(facts, { date: today, today, now });
      const actual = await tx.eligibilityState.findUnique({ where: { employeeId } });
      const expectedKeys = reasonKeys(expected.reasons);
      const actualKeys = actual ? reasonKeys(actual.reasons as unknown as Reason[]) : null;
      if (actual && actual.status === expected.status && sameKeys(expectedKeys, actualKeys!)) return;

      out.drifted++;
      out.driftedEmployeeIds.push(employeeId);
      if (!actual) out.missingState++;
      await tx.consistencyAuditLog.create({
        data: {
          employeeId, expectedStatus: expected.status, actualStatus: actual?.status ?? null,
          expectedReasons: expectedKeys, actualReasons: actualKeys ?? undefined, actualCalculatedAt: actual?.calculatedAt ?? null, runDate: today,
        },
      });
      await refreshEligibility(tx, employeeId, actual ? 'CONSISTENCY_AUDIT' : 'CONSISTENCY_AUDIT_MISSING_STATE', { now });
      await appendAudit(tx, {
        actorUserId: null, action: 'ELIGIBILITY_DRIFT_CORRECTED', resource: 'employee', resourceId: employeeId, priority: 'HIGH',
        changes: { expected: expected.status, stored: actual?.status ?? null, expectedReasons: expectedKeys, storedReasons: actualKeys, storedAt: actual?.calculatedAt?.toISOString() ?? null },
      });
    });
  }
  return out;
}

/** The scheduled job. `onlyIds` replaces the random sample (tests). */
export async function consistencyAudit(db: Db, now = new Date(), onlyIds?: number[]) {
  const population = await db.employee.count({ where: { deletedAt: null } });
  const sample = onlyIds ?? (await db.$queryRaw<Array<{ id: number }>>`SELECT id FROM employees WHERE deleted_at IS NULL ORDER BY random() LIMIT ${sampleSize(population)}`).map((r) => r.id);
  const out = await auditEmployees(db, sample, now);

  let notified = 0;
  if (out.drifted > 0) {
    // Drift means a code path skipped a refresh: System Admins should look.
    const admins = await db.roleAssignment.findMany({
      where: { role: 'SYSTEM_ADMIN', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], user: { isActive: true } },
      select: { userId: true }, distinct: ['userId'],
    });
    const r = await db.notification.createMany({
      data: admins.map((a) => ({
        recipientId: a.userId, type: 'SYSTEM' as const, priority: 'HIGH' as const,
        title: 'Eligibility drift corrected',
        message: `The daily consistency check found ${out.drifted} of ${out.checked} sampled nurses with a stored eligibility that no longer matched a fresh evaluation. Each was corrected; details are in Administration → Jobs.`,
        titleAr: 'تصحيح اختلاف في الأهلية',
        messageAr: `وجد الفحص اليومي ${out.drifted} من ${out.checked} ممرضاً بحالة أهلية مخزنة لا تطابق التقييم الحالي، وتم تصحيحها.`,
        eventKey: `consistency-audit:${riyadhDate(now)}`,
      })),
      skipDuplicates: true,
    });
    notified = r.count;
  }
  return { population, checked: out.checked, drifted: out.drifted, missingState: out.missingState, notified };
}
