// Badge-event ingest (spec §14.2, D-65). The hospital badge system (PACS)
// delivers clock events in batches to POST /api/v1/attendance/events, signed in
// as an API client with the attendance.ingest scope (D-63). Its real contract is
// not agreed yet (B-15), so the format is ours and small:
//   { events: [{ jobNumber, type, at, deviceId?, location? }] }   (≤ 1000)
// - `at` must carry its offset (e.g. 2026-09-25T06:52:00+03:00): a badge
//   reader's clock is never guessed.
// - Idempotent: an event already stored (same nurse, type and instant) counts as
//   a duplicate, so the badge system can resend a batch after a timeout.
// - Each event stands alone: unknown job numbers, deleted employees and times
//   in the future or more than MAX_AGE_DAYS old are rejected with their index;
//   the rest are stored. Nothing about the payload's personal data is logged.
// The Dev Console badge simulator (dev-console/routes.ts) uses the same path
// with source "simulator".

import { z } from 'zod';
import type { DbClient } from '../../lib/prisma.js';

export const MAX_BATCH = 1000;
export const MAX_AGE_DAYS = 7;
/** A reader's clock may run a little ahead of the server's. */
export const FUTURE_TOLERANCE_MINUTES = 5;
export const SIMULATOR_SOURCE = 'simulator';

const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, 'ISO 8601 with an offset, e.g. 2026-09-25T06:52:00+03:00');
export const BadgeEvent = z.strictObject({
  jobNumber: z.string().trim().min(1).max(40),
  type: z.enum(['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END']),
  at: Timestamp,
  deviceId: z.string().trim().max(80).optional(),
  location: z.string().trim().max(80).optional(),
});
export const IngestBody = z.strictObject({ events: z.array(z.unknown()).min(1).max(MAX_BATCH) });
export type BadgeEventInput = z.infer<typeof BadgeEvent>;

export interface IngestResult {
  received: number;
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; reason: 'INVALID' | 'UNKNOWN_JOB_NUMBER' | 'EMPLOYEE_DELETED' | 'IN_THE_FUTURE' | 'TOO_OLD'; detail?: string }>;
}

/** Validates and stores a batch; never throws for a single bad event. */
export async function ingestEvents(db: DbClient, raw: unknown[], source: string, now = new Date()): Promise<IngestResult> {
  const result: IngestResult = { received: raw.length, accepted: 0, duplicates: 0, rejected: [] };
  const parsed: Array<{ index: number; e: BadgeEventInput; at: Date }> = [];
  raw.forEach((item, index) => {
    const p = BadgeEvent.safeParse(item);
    if (!p.success) { result.rejected.push({ index, reason: 'INVALID', detail: p.error.issues.map((i) => `${i.path.join('.') || 'event'}: ${i.message}`).join('; ').slice(0, 300) }); return; }
    const at = new Date(p.data.at);
    if (Number.isNaN(at.getTime())) { result.rejected.push({ index, reason: 'INVALID', detail: 'at: not a real instant' }); return; }
    if (at.getTime() > now.getTime() + FUTURE_TOLERANCE_MINUTES * 60_000) { result.rejected.push({ index, reason: 'IN_THE_FUTURE' }); return; }
    if (at.getTime() < now.getTime() - MAX_AGE_DAYS * 86_400_000) { result.rejected.push({ index, reason: 'TOO_OLD' }); return; }
    parsed.push({ index, e: p.data, at });
  });

  const numbers = [...new Set(parsed.map((x) => x.e.jobNumber))];
  const employees = numbers.length ? await db.employee.findMany({ where: { jobNumber: { in: numbers } }, select: { id: true, jobNumber: true, deletedAt: true } }) : [];
  const byNumber = new Map(employees.map((e) => [e.jobNumber, e]));
  const rows = [];
  for (const { index, e, at } of parsed) {
    const emp = byNumber.get(e.jobNumber);
    if (!emp) { result.rejected.push({ index, reason: 'UNKNOWN_JOB_NUMBER' }); continue; }
    if (emp.deletedAt) { result.rejected.push({ index, reason: 'EMPLOYEE_DELETED' }); continue; }
    rows.push({ employeeId: emp.id, eventType: e.type, eventTimestamp: at, source, deviceId: e.deviceId ?? null, locationCode: e.location ?? null });
  }
  if (rows.length) {
    const { count } = await db.attendanceEvent.createMany({ data: rows, skipDuplicates: true });
    result.accepted = count;
    result.duplicates = rows.length - count;
  }
  result.rejected.sort((a, b) => a.index - b.index);
  return result;
}
