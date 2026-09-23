// Background jobs, notifications, audit reading and own session history
// against PostgreSQL: spec §6.1 daily transition, §6.2 revalidation, §7.1
// (N1–N4), §14.2 alerts, §9.1 audit, §10.3 leases; decisions D-20, D-22.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { addDays, riyadhDate, toDbDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { withLease } from '../src/lib/worker-lease.js';
import { attendanceAlerts } from '../src/jobs/attendance-alerts.js';
import { dailyTransition } from '../src/jobs/daily-transition.js';
import { expiryScan } from '../src/jobs/expiry-scan.js';
import { runJob, type JobDefinition } from '../src/jobs/scheduler.js';
import { makeEmployee, makeNurse, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const today = () => riyadhDate();

describeDb('jobs, notifications, audit and sessions', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
  });
  afterAll(async () => { await db.$disconnect(); });

  describe('daily transition', () => {
    it('moves contracts and credential statuses by date, closes ended grace, expires PAM, and is idempotent', async () => {
      const starting = await makeEmployee(db, org.unitA.id);
      const approved = await db.contract.create({ data: { employeeId: starting.id, jobNumber: starting.jobNumber, status: 'Approved', startDate: toDbDate(today()), endDate: toDbDate(addDays(today(), 300)) } });
      const ending = await makeEmployee(db, org.unitA.id);
      const active = await db.contract.create({ data: { employeeId: ending.id, jobNumber: ending.jobNumber, status: 'Active', startDate: toDbDate(addDays(today(), -300)), endDate: toDbDate(addDays(today(), -1)) } });
      const tpl = await makeTemplate(db, { gracePeriodDays: 10 });
      const stale = await db.credential.create({ data: { employeeId: ending.id, templateId: tpl.id, status: 'Valid', trackingData: {}, expiryDate: toDbDate(addDays(today(), -2)) } });
      const soon = await db.credential.create({ data: { employeeId: ending.id, templateId: tpl.id, status: 'Valid', trackingData: {}, expiryDate: toDbDate(addDays(today(), 20)) } });
      const graced = await db.credential.create({ data: { employeeId: starting.id, templateId: tpl.id, status: 'Expired', trackingData: {}, expiryDate: toDbDate(addDays(today(), -30)), graceCycleId: `${uniq('g')}:x`, graceExpiryDate: toDbDate(addDays(today(), -1)) } });
      const hr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
      const admin = await makeUser(db);
      await db.privilegedSession.create({ data: { userId: admin.id, reason: 'expired elevation', expiresAt: new Date(Date.now() - 60_000) } });

      // A published shift for the nurse whose contract just ended must return to draft.
      const shift = await db.shiftAssignment.create({ data: { employeeId: ending.id, unitId: org.unitA.id, shiftDate: toDbDate(addDays(today(), 2)), shiftType: 'Morning', status: 'Published' } });

      const s = await dailyTransition(db);
      expect(s.refreshFailures).toBe(0);
      expect((await db.contract.findUniqueOrThrow({ where: { id: approved.id } })).status).toBe('Active');
      expect((await db.contract.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('Expired');
      expect((await db.credential.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('Expired');
      expect((await db.credential.findUniqueOrThrow({ where: { id: soon.id } })).status).toBe('ExpiringSoon');
      expect((await db.credential.findUniqueOrThrow({ where: { id: graced.id } })).graceCycleId).toMatch(/:closed$/);
      expect(await db.notification.count({ where: { recipientId: hr.id, eventKey: { startsWith: 'grace-expired:' }, employeeId: starting.id } })).toBe(1);
      expect(await db.privilegedSession.findUnique({ where: { userId: admin.id } })).toBeNull();
      expect((await db.shiftAssignment.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe('Draft');
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: ending.id } })).updatedByEvent).toBe('DAILY_TRANSITION');

      await dailyTransition(db);
      expect(await db.auditEntry.count({ where: { action: 'CONTRACT_EXPIRED', resourceId: String(active.id) } })).toBe(1);
      expect(await db.auditEntry.count({ where: { action: 'GRACE_EXPIRED', resourceId: String(graced.id) } })).toBe(1);
    }, 120_000);
  });

  describe('expiry scan (N1–N3)', () => {
    it('notifies the employee and scoped HR once per record, expiry date and milestone', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      await db.contract.updateMany({ where: { employeeId: emp.id }, data: { endDate: toDbDate(addDays(today(), 30)) } });
      const tpl = await makeTemplate(db);
      await db.credential.create({ data: { employeeId: emp.id, templateId: tpl.id, status: 'Expired', trackingData: {}, expiryDate: toDbDate(addDays(today(), -3)) } });
      const scopedHr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
      const otherHr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] });

      await expiryScan(db);
      for (const id of [user!.id, scopedHr.id]) {
        expect(await db.notification.count({ where: { recipientId: id, employeeId: emp.id, eventKey: { endsWith: ':within-90' } } })).toBe(1);
        expect(await db.notification.count({ where: { recipientId: id, employeeId: emp.id, eventKey: { endsWith: ':expired' } } })).toBe(1);
      }
      expect(await db.notification.count({ where: { recipientId: otherHr.id, employeeId: emp.id } })).toBe(0);
      await expiryScan(db);
      expect(await db.notification.count({ where: { recipientId: user!.id, employeeId: emp.id } })).toBe(2);
    }, 120_000);
  });

  describe('attendance alerts (§14.2)', () => {
    it('alerts the unit supervisors once when a nurse has not clocked in 30 minutes after the start', async () => {
      const unit = await db.unit.create({ data: { code: uniq('AL').toUpperCase().slice(0, 20), name: 'Alert unit', departmentId: org.dept.id } });
      const sup = await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [unit.id] }] });
      const absent = (await makeNurse(db, unit.id)).emp;
      const present = (await makeNurse(db, unit.id)).emp;
      const date = today();
      for (const e of [absent, present]) {
        await db.shiftAssignment.create({ data: { employeeId: e.id, unitId: unit.id, shiftDate: toDbDate(date), shiftType: 'Morning', status: 'Published' } });
      }
      await db.attendanceEvent.create({ data: { employeeId: present.id, eventType: 'CLOCK_IN', eventTimestamp: new Date(`${date}T07:02:00+03:00`) } });

      expect((await attendanceAlerts(db, new Date(`${date}T07:20:00+03:00`))).missing).toBe(0); // still within 30 minutes
      const at = new Date(`${date}T07:40:00+03:00`);
      await attendanceAlerts(db, at);
      await attendanceAlerts(db, new Date(`${date}T07:55:00+03:00`));
      const alerts = await db.notification.findMany({ where: { recipientId: sup.id } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ employeeId: absent.id, priority: 'CRITICAL', type: 'COVERAGE' });
      expect((await attendanceAlerts(db, new Date(`${date}T16:00:00+03:00`))).checked).toBe(0); // the shift is over
    }, 120_000);
  });

  describe('scheduler and leases', () => {
    const fake = (fn: () => Promise<Record<string, unknown>>): JobDefinition => ({ name: uniq('test-job'), schedule: 'test', periodKey: () => null, run: fn });

    it('runs a period once, retries a failure, and never runs one job twice at once', async () => {
      let calls = 0;
      const ok = fake(async () => ({ calls: ++calls }));
      const key = `${ok.name}:p1`;
      expect((await runJob(db, ok, key)).status).toBe('COMPLETED');
      expect((await runJob(db, ok, key)).status).toBe('SKIPPED');
      expect(calls).toBe(1);

      let fail = true;
      const flaky = fake(async () => { if (fail) throw new Error('boom'); return {}; });
      expect((await runJob(db, flaky, `${flaky.name}:p1`)).status).toBe('FAILED');
      fail = false;
      expect((await runJob(db, flaky, `${flaky.name}:p1`)).status).toBe('COMPLETED');
      expect((await db.jobRun.findUniqueOrThrow({ where: { runKey: `${flaky.name}:p1` } })).attempts).toBe(2);

      let inner: Awaited<ReturnType<typeof withLease>> | undefined;
      const outer = await withLease(db, 'lease-test', 30, async () => { inner = await withLease(db, 'lease-test', 30, async () => 'second'); return 'first'; });
      expect(outer).toEqual({ ran: true, result: 'first' });
      expect(inner).toEqual({ ran: false });
      expect((await withLease(db, 'lease-test', 30, async () => 'again')).ran).toBe(true);
    });
  });

  describe('notifications API (N2)', () => {
    it('lists and acknowledges only the caller\'s own notifications', async () => {
      const a = await makeUser(db);
      const b = await makeUser(db);
      const mine = await db.notification.create({ data: { recipientId: a.id, type: 'SYSTEM', title: 't', message: 'm' } });
      const theirs = await db.notification.create({ data: { recipientId: b.id, type: 'SYSTEM', title: 't', message: 'm' } });
      const client = await signIn(app, a.email);
      const list = await client.get('/notifications?unread=true');
      expect(list.body.items.map((n: { id: number }) => n.id)).toEqual([mine.id]);
      expect(list.body.unread).toBe(1);
      expect((await client.post(`/notifications/${theirs.id}/read`)).status).toBe(404);
      expect((await db.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull();
      expect((await client.post(`/notifications/${mine.id}/read`)).body.read).toBe(true);
      expect((await client.get('/notifications')).body.unread).toBe(0);
    });
  });

  describe('audit reading (D-20)', () => {
    it('is System Admin only, filters, and verifies the chain', async () => {
      const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      expect((await hr.get('/audit')).status).toBe(403);
      const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
      const res = await sa.get('/audit?action=LOGIN_SUCCEEDED&pageSize=5');
      expect(res.status).toBe(200);
      expect(res.body.items.every((e: { action: string; id: string }) => e.action === 'LOGIN_SUCCEEDED' && typeof e.id === 'string')).toBe(true);
      expect((await sa.get('/audit/verify')).body.intact).toBe(true);
      const jobs = await sa.get('/admin/jobs');
      expect(jobs.body.items.map((j: { name: string }) => j.name)).toEqual(['daily-transition', 'expiry-scan', 'attendance-alerts']);
      expect((await hr.post('/admin/jobs/expiry-scan/run')).status).toBe(403);
    });
  });

  describe('own session history (D-22)', () => {
    it('shows the caller\'s sign-ins with address and browser, and nothing of anyone else', async () => {
      const u = await makeUser(db);
      const other = await makeUser(db);
      await signIn(app, other.email);
      const first = await signIn(app, u.email);
      await first.refresh();
      const second = await signIn(app, u.email);
      const res = await second.get('/auth/sessions');
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ current: true, active: true });
      expect(res.body.items[0].signInIp).toBeTruthy();
      await first.agent.post('/api/v1/auth/logout').set('Origin', 'http://localhost:5173').set('X-CSRF-Token', first.session.csrf);
      const after = (await second.get('/auth/sessions')).body.items;
      expect(after.find((s: { current: boolean }) => !s.current).active).toBe(false);
    });
  });
});
