// Attendance (spec §14.2; decision D-33). Clock events arrive from the
// hospital badge system (PACS); that feed's contract is not defined (B-15), so
// no ingest endpoint exists yet — this module reads events and compares them
// with the published roster ("planned vs actual").
//
// Gap rules, as the spec states them:
//   - MISSING: published for the shift, no CLOCK_IN at or after the shift start,
//     and at least 30 minutes have passed since the start.
//   - INELIGIBLE_ON_DUTY: clocked in, but the engine blocks the nurse today.
// The spec counts only clock-ins at or after the shift start; an early
// arrival therefore shows as MISSING. Kept literal — see the plan's commit 8 notes.
// This is the on-demand view; jobs/attendance-alerts.ts sends the 15-minute alerts.

import { z } from 'zod';
import { shiftWindow, type ShiftType } from '../../config/shifts.js';
import { addDays, daysBetween, dbDate, isIsoDate, riyadhDate, toDbDate } from '../../lib/dates.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { evaluate } from '../eligibility/engine.js';
import { loadFacts } from '../eligibility/state.service.js';
import { unitScope, type AuthContext } from '../users/access.js';

export const GAP_MINUTES = 30; // spec §14.2
const READ_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'] as const;
const IsoDateStr = z.string().refine(isIsoDate, 'YYYY-MM-DD');

export const EventsQuery = z.object({
  employeeId: z.coerce.number().int().positive().optional(),
  unitId: z.coerce.number().int().positive().optional(),
  from: IsoDateStr, to: IsoDateStr,
}).superRefine((q, ctx) => {
  if (!q.employeeId && !q.unitId) ctx.addIssue({ code: 'custom', message: 'Give an employeeId or a unitId' });
  if (isIsoDate(q.from) && isIsoDate(q.to) && (q.to < q.from || daysBetween(q.from, q.to) + 1 > 94)) ctx.addIssue({ code: 'custom', path: ['to'], message: 'A window of 1–94 days is required (S6)' });
});
export const OwnEventsQuery = z.object({ from: IsoDateStr, to: IsoDateStr });
export const GapsQuery = z.object({ unitId: z.coerce.number().int().positive(), date: IsoDateStr.optional() });

/** Riyadh calendar range [from, to] as instants. */
const instants = (from: string, to: string) => ({ gte: new Date(`${from}T00:00:00+03:00`), lt: new Date(`${addDays(to, 1)}T00:00:00+03:00`) });

export type GapStatus = 'UPCOMING' | 'PENDING' | 'MISSING' | 'PRESENT' | 'INELIGIBLE_ON_DUTY';

/** One published shift against its clock-ins (spec §14.2). Shared by the gap view and the alert job. */
export async function classifyShift(db: DbClient, a: { employeeId: number; shiftDate: Date; shiftType: string }, now: Date) {
  const date = dbDate(a.shiftDate);
  const today = riyadhDate(now);
  const { start, end } = shiftWindow(date, a.shiftType as ShiftType);
  const clockIn = await db.attendanceEvent.findFirst({
    where: { employeeId: a.employeeId, eventType: 'CLOCK_IN', eventTimestamp: { gte: start, lt: end } },
    orderBy: { eventTimestamp: 'asc' }, select: { eventTimestamp: true },
  });
  let status: GapStatus;
  let reasons: string[] = [];
  if (clockIn) {
    status = 'PRESENT';
    if (date === today || (now >= start && now < end)) {
      const r = evaluate(await loadFacts(db, a.employeeId, now), { date: today, today, now });
      if (r.status === 'INELIGIBLE') { status = 'INELIGIBLE_ON_DUTY'; reasons = r.reasons.filter((x) => x.severity === 'BLOCK').map((x) => x.code); }
    }
  } else if (now < start) status = 'UPCOMING';
  else if (now.getTime() - start.getTime() >= GAP_MINUTES * 60_000) status = 'MISSING';
  else status = 'PENDING';
  return { shiftStart: start, shiftEnd: end, clockInAt: clockIn?.eventTimestamp ?? null, status, reasons };
}

export function createAttendanceService(db: Db) {
  async function scope(auth: AuthContext) { return unitScope(db, auth, READ_ROLES); }
  const inScope = (s: Awaited<ReturnType<typeof scope>>, unitId: number | null) => s.all || (unitId !== null && s.unitIds.has(unitId));

  return {
    async events(auth: AuthContext, q: z.infer<typeof EventsQuery>) {
      const s = await scope(auth);
      let employeeIds: number[];
      if (q.employeeId) {
        const e = await db.employee.findUnique({ where: { id: q.employeeId }, select: { unitId: true } });
        if (!e) throw notFound('Employee not found');
        if (!inScope(s, e.unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This employee is outside your assigned scope');
        employeeIds = [q.employeeId];
      } else {
        if (!inScope(s, q.unitId!)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your assigned scope');
        employeeIds = (await db.employee.findMany({ where: { unitId: q.unitId }, select: { id: true } })).map((e) => e.id);
      }
      const items = await db.attendanceEvent.findMany({
        where: { employeeId: { in: employeeIds }, eventTimestamp: instants(q.from, q.to) },
        include: { employee: { select: { jobNumber: true, fullName: true } } },
        orderBy: { eventTimestamp: 'asc' }, take: 5000,
      });
      return { items, total: items.length };
    },

    async own(auth: AuthContext, q: z.infer<typeof OwnEventsQuery>) {
      if (auth.user.employeeId === null) return { items: [], total: 0 };
      const items = await db.attendanceEvent.findMany({ where: { employeeId: auth.user.employeeId, eventTimestamp: instants(q.from, q.to) }, orderBy: { eventTimestamp: 'asc' } });
      return { items, total: items.length };
    },

    /** Published shifts of a unit on a date (default today, Riyadh) compared with clock-ins. */
    async gaps(auth: AuthContext, q: z.infer<typeof GapsQuery>, now = new Date()) {
      if (!(await db.unit.findUnique({ where: { id: q.unitId }, select: { id: true } }))) throw notFound('Unit not found');
      if (!inScope(await scope(auth), q.unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This unit is outside your assigned scope');
      const date = q.date ?? riyadhDate(now);
      const shifts = await db.shiftAssignment.findMany({
        where: { unitId: q.unitId, status: 'Published', shiftDate: toDbDate(date) },
        include: { employee: { select: { jobNumber: true, fullName: true } } },
        orderBy: [{ shiftType: 'asc' }, { employeeId: 'asc' }],
      });
      const items = [];
      for (const a of shifts) {
        items.push({ assignmentId: a.id, employeeId: a.employeeId, jobNumber: a.employee.jobNumber, fullName: a.employee.fullName, shiftType: a.shiftType, ...(await classifyShift(db, a, now)) });
      }
      return { unitId: q.unitId, date, gapMinutes: GAP_MINUTES, items };
    },
  };
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;
