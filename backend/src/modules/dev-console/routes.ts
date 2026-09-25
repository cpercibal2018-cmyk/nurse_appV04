// Dev Console (D-59): the SMS inbox. While SMS_DRIVER=mock the SMS gateway keeps
// every outgoing text in mock_sms_outbox instead of sending it; System Admins read
// them here, newest first, and can send a test text to show the flow. The inbox
// holds phone numbers, so it is System Admin only and purged after 30 days.
//
// D-64: the simulated SCFHS registry. While SCFHS_DRIVER=mock, licence checks are
// answered from mock_scfhs_registry; a System Admin sets what "SCFHS" says for a
// registration number (valid, expired, suspended, revoked, or ERROR for an
// outage) to demonstrate each outcome. Synthetic entries only.
//
// D-65: the badge simulator. Until the badge system (PACS) delivers clock events,
// a System Admin writes them here — one swipe, or clock-ins for a unit's
// published shift, leaving some nurses out — so the gap view and the coverage
// alerts can be shown. The events go through the same ingest as the badge
// system's, marked source "simulator", audited HIGH, and can be cleared. Off in
// production unless BADGE_SIMULATOR=on.

import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { maskPhone, normalizePhone, SMS_MAX_LENGTH, SMS_PHONE, type SmsGateway } from '../../lib/sms.js';
import { isIsoDate, riyadhDate, toDbDate } from '../../lib/dates.js';
import { shiftWindow, SHIFT_TYPES, type ShiftType } from '../../config/shifts.js';
import { BadgeEvent, ingestEvents, SIMULATOR_SOURCE } from '../attendance/ingest.js';
import { EARLY_CLOCK_IN_MINUTES } from '../attendance/service.js';
import { maskReg, normalizeReg, SCFHS_REG, type ScfhsDriver } from '../../lib/scfhs.js';
import { authOf, authorize } from '../../middleware/authorize.js';

export const InboxQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
export const TestSmsBody = z.strictObject({
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(SMS_PHONE, 'Phone: international format, e.g. +966501234567')),
  message: z.string().trim().min(1).max(SMS_MAX_LENGTH),
});

export const RegistryParam = z.object({ reg: z.string().transform(normalizeReg).pipe(z.string().regex(SCFHS_REG, 'Registration number: letters, digits and hyphens')) });
export const RegistryBody = z.strictObject({
  status: z.enum(['VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'ERROR']),
  expiryDate: z.string().refine(isIsoDate, 'YYYY-MM-DD').nullable().default(null),
  specialty: z.string().trim().max(200).nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
});

export const SimulatedSwipe = BadgeEvent.pick({ jobNumber: true, type: true }).extend({ at: BadgeEvent.shape.at.optional() }).strict();
export const SimulatedShift = z.strictObject({
  unitId: z.number().int().positive(),
  date: z.string().refine(isIsoDate, 'YYYY-MM-DD').optional(),
  shiftType: z.enum(SHIFT_TYPES as [ShiftType, ...ShiftType[]]),
  /** How many of the shift's nurses to leave out (chosen at random): they show as MISSING. */
  leaveOut: z.number().int().min(0).max(500).default(0),
});

export function createDevConsoleRouter(db: Db, sms: SmsGateway, scfhsDriver: ScfhsDriver, badgeSimulator: boolean) {
  const r = Router();

  r.get('/dev-console/sms-inbox', authorize('devconsole.sms.read'), async (req, res) => {
    const { limit } = InboxQuery.parse(req.query);
    const [items, total] = await Promise.all([
      db.mockSmsOutbox.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit }),
      db.mockSmsOutbox.count(),
    ]);
    res.json({ driver: sms.driver, items, total });
  });

  r.post('/dev-console/sms-inbox/test', authorize('devconsole.sms.send'), async (req, res) => {
    const body = TestSmsBody.parse(req.body);
    const accepted = await sms.send(body.phone, body.message);
    await appendAudit(db, {
      actorUserId: authOf(res).user.id, action: 'SMS_TEST_SENT', resource: 'sms', changes: { driver: sms.driver, phone: maskPhone(body.phone), accepted }, requestId: res.locals.requestId,
    });
    if (!accepted) throw new HttpError(502, 'SMS_NOT_ACCEPTED', sms.driver === 'mock' ? 'The text could not be saved to the SMS inbox' : 'The SMS gateway did not accept the text');
    res.status(201).json({ accepted, driver: sms.driver });
  });

  // ── Badge simulator (D-65) ─────────────────────────────────────────────
  const simulatorOn = () => { if (!badgeSimulator) throw new HttpError(409, 'BADGE_SIMULATOR_OFF', 'The badge simulator is off on this server (BADGE_SIMULATOR)'); };

  r.get('/dev-console/badge-simulator', authorize('devconsole.badge.read'), async (_req, res) => {
    const [recent, total] = await Promise.all([
      db.attendanceEvent.findMany({ where: { source: SIMULATOR_SOURCE }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, include: { employee: { select: { jobNumber: true, fullName: true } } } }),
      db.attendanceEvent.count({ where: { source: SIMULATOR_SOURCE } }),
    ]);
    res.json({ enabled: badgeSimulator, recent, total });
  });

  r.post('/dev-console/badge-simulator/events', authorize('devconsole.badge.write'), async (req, res) => {
    simulatorOn();
    const body = SimulatedSwipe.parse(req.body);
    const result = await ingestEvents(db, [{ ...body, at: body.at ?? new Date().toISOString() }], SIMULATOR_SOURCE);
    await appendAudit(db, { actorUserId: authOf(res).user.id, action: 'BADGE_SIMULATED', resource: 'attendance_events', changes: { kind: 'swipe', type: body.type, accepted: result.accepted, rejected: result.rejected.map((x) => x.reason) }, requestId: res.locals.requestId, priority: 'HIGH' });
    if (result.rejected.length) throw new HttpError(422, `BADGE_${result.rejected[0]!.reason}`, 'The swipe was not accepted', result.rejected.map((x) => x.detail ?? x.reason));
    res.status(201).json(result);
  });

  r.post('/dev-console/badge-simulator/shift', authorize('devconsole.badge.write'), async (req, res) => {
    simulatorOn();
    const body = SimulatedShift.parse(req.body);
    const now = new Date();
    const date = body.date ?? riyadhDate(now);
    const { start, end } = shiftWindow(date, body.shiftType);
    // Clock-ins count from 30 minutes before the start (D-38); nothing is written for a time still ahead.
    if (start.getTime() - 30 * 60_000 > now.getTime()) throw new HttpError(409, 'SHIFT_NOT_STARTED', 'This shift has not started yet — clock-ins open 30 minutes before its start');
    const shifts = await db.shiftAssignment.findMany({
      where: { unitId: body.unitId, status: 'Published', shiftDate: toDbDate(date), shiftType: body.shiftType },
      include: { employee: { select: { jobNumber: true } } },
    });
    if (shifts.length === 0) throw new HttpError(404, 'NO_PUBLISHED_SHIFT', 'Nobody is published for this unit, date and shift');
    // Running it again must not clock in a nurse twice, nor one left out before: only those not yet badged in count.
    const inAlready = new Set((await db.attendanceEvent.findMany({
      where: { employeeId: { in: shifts.map((s) => s.employeeId) }, eventType: 'CLOCK_IN', eventTimestamp: { gte: new Date(start.getTime() - EARLY_CLOCK_IN_MINUTES * 60_000), lt: end } },
      select: { employeeId: true },
    })).map((e) => e.employeeId));
    const waiting = shifts.filter((s) => !inAlready.has(s.employeeId));
    const order = waiting.map((s) => ({ s, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.s);
    const leftOut = order.slice(0, Math.min(body.leaveOut, order.length));
    const present = order.slice(leftOut.length);
    // Each nurse badges in 0–20 minutes before the start, never later than now.
    const events = present.map((s) => ({
      jobNumber: s.employee.jobNumber, type: 'CLOCK_IN' as const,
      at: new Date(Math.min(start.getTime() - Math.floor(Math.random() * 20) * 60_000, now.getTime())).toISOString(),
    }));
    const result = await ingestEvents(db, events, SIMULATOR_SOURCE, now);
    await appendAudit(db, {
      actorUserId: authOf(res).user.id, action: 'BADGE_SIMULATED', resource: 'attendance_events',
      changes: { kind: 'shift', unitId: body.unitId, date, shiftType: body.shiftType, clockedIn: result.accepted, alreadyIn: inAlready.size, leftOut: leftOut.length }, requestId: res.locals.requestId, priority: 'HIGH',
    });
    res.status(201).json({ ...result, date, alreadyIn: inAlready.size, leftOut: leftOut.map((s) => s.employee.jobNumber) });
  });

  r.delete('/dev-console/badge-simulator/events', authorize('devconsole.badge.write'), async (_req, res) => {
    const { count } = await db.attendanceEvent.deleteMany({ where: { source: SIMULATOR_SOURCE } });
    await appendAudit(db, { actorUserId: authOf(res).user.id, action: 'BADGE_SIMULATION_CLEARED', resource: 'attendance_events', changes: { deleted: count }, requestId: res.locals.requestId, priority: 'HIGH' });
    res.json({ deleted: count });
  });

  r.get('/dev-console/scfhs-registry', authorize('devconsole.scfhs.read'), async (_req, res) => {
    const items = await db.mockScfhsRegistry.findMany({ orderBy: { registrationNumber: 'asc' }, take: 1000 });
    res.json({ driver: scfhsDriver, items });
  });

  r.put('/dev-console/scfhs-registry/:reg', authorize('devconsole.scfhs.manage'), async (req, res) => {
    const { reg } = RegistryParam.parse(req.params);
    const body = RegistryBody.parse(req.body);
    const entry = await db.$transaction(async (tx) => {
      const e = await tx.mockScfhsRegistry.upsert({ where: { registrationNumber: reg }, update: body, create: { registrationNumber: reg, ...body } });
      await appendAudit(tx, { actorUserId: authOf(res).user.id, action: 'SCFHS_REGISTRY_SET', resource: 'scfhs_registry', resourceId: maskReg(reg), changes: { status: body.status, expiryDate: body.expiryDate }, requestId: res.locals.requestId });
      return e;
    });
    res.json(entry);
  });

  r.delete('/dev-console/scfhs-registry/:reg', authorize('devconsole.scfhs.manage'), async (req, res) => {
    const { reg } = RegistryParam.parse(req.params);
    const removed = await db.$transaction(async (tx) => {
      const { count } = await tx.mockScfhsRegistry.deleteMany({ where: { registrationNumber: reg } });
      if (count) await appendAudit(tx, { actorUserId: authOf(res).user.id, action: 'SCFHS_REGISTRY_REMOVED', resource: 'scfhs_registry', resourceId: maskReg(reg), requestId: res.locals.requestId });
      return count;
    });
    if (!removed) throw new HttpError(404, 'NOT_FOUND', 'No registry entry for this number');
    res.status(204).end();
  });

  return r;
}
