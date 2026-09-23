// Coverage alerts (spec §14.2). Every 15 minutes: published shifts that are
// under way where the nurse has not clocked in 30 minutes after the start, or
// has clocked in but is ineligible today. A CRITICAL in-app notification goes
// to the unit's supervisors — the spec's "push" channel is not built. One alert
// per assignment and kind: the (recipient, event key) unique index makes the
// suppression provable, as §14.2 suggests.

import { addDays, riyadhDate, toDbDate } from '../lib/dates.js';
import type { Db } from '../lib/prisma.js';
import { classifyShift } from '../modules/attendance/service.js';
import { recipientsForUnit } from '../modules/eligibility/state.service.js';

export async function attendanceAlerts(db: Db, now = new Date()) {
  const today = riyadhDate(now);
  // Yesterday too: a Night shift dated yesterday runs until 07:00 today.
  const shifts = await db.shiftAssignment.findMany({
    where: { status: 'Published', shiftDate: { in: [toDbDate(addDays(today, -1)), toDbDate(today)] } },
    include: { employee: { select: { jobNumber: true, fullName: true } }, unit: { select: { code: true } } },
  });
  const summary = { checked: 0, missing: 0, ineligibleOnDuty: 0, notificationsCreated: 0 };
  for (const a of shifts) {
    const g = await classifyShift(db, a, now);
    if (now >= g.shiftEnd) continue; // only shifts still under way
    summary.checked++;
    if (g.status !== 'MISSING' && g.status !== 'INELIGIBLE_ON_DUTY') continue;
    const missing = g.status === 'MISSING';
    if (missing) summary.missing++; else summary.ineligibleOnDuty++;
    const who = `${a.employee.jobNumber} ${a.employee.fullName}`;
    const recipients = await recipientsForUnit(db, 'SUPERVISOR', a.unitId, now);
    const r = await db.notification.createMany({
      data: recipients.map((recipientId) => ({
        recipientId, employeeId: a.employeeId, type: 'COVERAGE' as const, priority: 'CRITICAL' as const,
        title: missing ? 'Critical coverage alert: not clocked in' : 'Critical coverage alert: ineligible nurse on duty',
        message: missing
          ? `${who} is scheduled for ${a.unit.code} ${a.shiftType} and has not clocked in 30 minutes after the start.`
          : `${who} has clocked in for ${a.unit.code} ${a.shiftType} but is not eligible today (${g.reasons.join(', ')}).`,
        titleAr: 'تنبيه تغطية حرج',
        messageAr: missing
          ? `${who} مجدول في ${a.unit.code} (${a.shiftType}) ولم يسجل الدخول بعد 30 دقيقة من البداية.`
          : `${who} سجل الدخول في ${a.unit.code} (${a.shiftType}) لكنه غير مؤهل اليوم (${g.reasons.join('، ')}).`,
        eventKey: `${missing ? 'gap-missing' : 'gap-ineligible'}:${a.id}`,
      })),
      skipDuplicates: true,
    });
    summary.notificationsCreated += r.count;
  }
  return summary;
}
