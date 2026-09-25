// Badge-event ingest and the badge simulator (spec §14.2, D-65): the badge
// system, signed in as an API client with attendance.ingest, delivers batches
// judged event by event and safe to resend; nobody else can; the Dev Console
// simulator writes through the same path, can be cleared, and is off when told.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { addDays, riyadhDate, toDbDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { SIMULATOR_SOURCE } from '../src/modules/attendance/ingest.js';
import { makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const EVENTS = '/api/v1/attendance/events';

describeDb('badge-event ingest (spec §14.2, D-65)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let sa: Awaited<ReturnType<typeof signIn>>;
  let hr: Awaited<ReturnType<typeof signIn>>;

  async function clientToken(scopes: string[]) {
    const c = await sa.post('/api-clients', { name: uniq('PACS'), scopes });
    expect(c.status).toBe(201);
    const t = await request(app).post('/api/v1/fhir/token').auth(c.body.client.clientId, c.body.clientSecret).type('form').send({ grant_type: 'client_credentials' });
    expect(t.status).toBe(200);
    return { bearer: `Bearer ${t.body.access_token}`, clientId: c.body.client.clientId as string };
  }
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  it('the badge system delivers a batch: each event judged alone, a resend counts duplicates, the source is the client', async () => {
    const pacs = await clientToken(['attendance.ingest']);
    const a = await makeNurse(db, org.unitA.id);
    const gone = await makeNurse(db, org.unitA.id);
    await db.employee.update({ where: { id: gone.emp.id }, data: { deletedAt: new Date() } });
    const at = minutesAgo(10);
    const batch = [
      { jobNumber: a.emp.jobNumber, type: 'CLOCK_IN', at, deviceId: 'GATE-3', location: 'ICU-EAST' },
      { jobNumber: a.emp.jobNumber, type: 'CLOCK_IN', at }, // the same swipe twice in one batch
      { jobNumber: 'NO-SUCH-NUMBER', type: 'CLOCK_IN', at },
      { jobNumber: gone.emp.jobNumber, type: 'CLOCK_IN', at },
      { jobNumber: a.emp.jobNumber, type: 'CLOCK_OUT', at: new Date(Date.now() + 3_600_000).toISOString() },
      { jobNumber: a.emp.jobNumber, type: 'CLOCK_OUT', at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
      { jobNumber: a.emp.jobNumber, type: 'CLOCK_OUT', at: '2026-09-25 07:00' }, // no offset
      { jobNumber: a.emp.jobNumber, type: 'LUNCH', at },
    ];
    const res = await request(app).post(EVENTS).set('Authorization', pacs.bearer).send({ events: batch });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: 8, accepted: 1, duplicates: 1 });
    expect(res.body.rejected.map((r: { index: number; reason: string }) => [r.index, r.reason])).toEqual([
      [2, 'UNKNOWN_JOB_NUMBER'], [3, 'EMPLOYEE_DELETED'], [4, 'IN_THE_FUTURE'], [5, 'TOO_OLD'], [6, 'INVALID'], [7, 'INVALID'],
    ]);
    const stored = await db.attendanceEvent.findFirstOrThrow({ where: { employeeId: a.emp.id } });
    expect(stored).toMatchObject({ eventType: 'CLOCK_IN', source: `client:${pacs.clientId}`, deviceId: 'GATE-3', locationCode: 'ICU-EAST' });
    expect(stored.eventTimestamp.toISOString()).toBe(at);

    // Resending after a timeout stores nothing twice.
    const again = await request(app).post(EVENTS).set('Authorization', pacs.bearer).send({ events: [batch[0]] });
    expect(again.body).toMatchObject({ accepted: 0, duplicates: 1, rejected: [] });
    // HR sees the event in the usual view.
    expect((await hr.get(`/attendance/events?employeeId=${a.emp.id}&from=${addDays(riyadhDate(), -1)}&to=${riyadhDate()}`)).body.total).toBe(1);

    expect((await request(app).post(EVENTS).set('Authorization', pacs.bearer).send({ events: [] })).status).toBe(400);
    expect((await request(app).post(EVENTS).set('Authorization', pacs.bearer).send({ events: Array.from({ length: 1001 }, () => batch[0]) })).status).toBe(400);
  });

  it('only a client holding attendance.ingest may deliver — not a FHIR client, not a person; the ingest token opens nothing else', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const body = { events: [{ jobNumber: emp.jobNumber, type: 'CLOCK_IN', at: minutesAgo(5) }] };
    const fhirOnly = await clientToken(['system/Practitioner.read']);
    expect((await request(app).post(EVENTS).set('Authorization', fhirOnly.bearer).send(body)).status).toBe(403);
    const hrRes = await hr.post('/attendance/events', body);
    expect(hrRes.status).toBe(403);
    expect(hrRes.body.error.code).toBe('FORBIDDEN');
    expect((await sa.post('/attendance/events', body)).status).toBe(403);

    const pacs = await clientToken(['attendance.ingest']);
    expect((await request(app).get(`/api/v1/fhir/Practitioner/${emp.id}`).set('Authorization', pacs.bearer)).status).toBe(403); // no FHIR scope
    expect((await request(app).get(`/api/v1/attendance/events?employeeId=${emp.id}&from=${riyadhDate()}&to=${riyadhDate()}`).set('Authorization', pacs.bearer)).status).toBe(401);
    expect((await request(app).post('/api/v1/shift-assignments').set('Authorization', pacs.bearer).send({})).status).toBe(401);
    expect(await db.attendanceEvent.count({ where: { employeeId: emp.id } })).toBe(0);
  });

  it('the badge simulator: one swipe, a published shift with nurses left out (they show as MISSING), clearing — audited', async () => {
    const yesterday = addDays(riyadhDate(), -1);
    const nurses = [await makeNurse(db, org.unitB.id), await makeNurse(db, org.unitB.id), await makeNurse(db, org.unitB.id)];
    for (const n of nurses) {
      await db.shiftAssignment.create({ data: { employeeId: n.emp.id, unitId: org.unitB.id, shiftDate: toDbDate(yesterday), shiftType: 'Morning', status: 'Published' } });
    }
    const shift = await sa.post('/dev-console/badge-simulator/shift', { unitId: org.unitB.id, date: yesterday, shiftType: 'Morning', leaveOut: 1 });
    expect(shift.status).toBe(201);
    expect(shift.body).toMatchObject({ accepted: 2, date: yesterday });
    expect(shift.body.leftOut).toHaveLength(1);

    // Run again: nobody is clocked in twice, and the nurse left out stays out unless asked for.
    const again = await sa.post('/dev-console/badge-simulator/shift', { unitId: org.unitB.id, date: yesterday, shiftType: 'Morning', leaveOut: 1 });
    expect(again.body).toMatchObject({ accepted: 0, alreadyIn: 2, leftOut: [shift.body.leftOut[0]] });

    const gaps = await hr.get(`/attendance/gaps?unitId=${org.unitB.id}&date=${yesterday}`);
    const byNumber = new Map(gaps.body.items.map((g: { jobNumber: string; status: string }) => [g.jobNumber, g.status]));
    expect(byNumber.get(shift.body.leftOut[0])).toBe('MISSING');
    expect([...byNumber.values()].filter((s) => s === 'PRESENT')).toHaveLength(2);

    const swipe = await sa.post('/dev-console/badge-simulator/events', { jobNumber: nurses[0]!.emp.jobNumber, type: 'CLOCK_OUT' });
    expect(swipe.status).toBe(201);
    expect((await sa.post('/dev-console/badge-simulator/events', { jobNumber: 'NOPE', type: 'CLOCK_IN' })).body.error.code).toBe('BADGE_UNKNOWN_JOB_NUMBER');
    expect((await sa.post('/dev-console/badge-simulator/shift', { unitId: org.unitB.id, date: addDays(riyadhDate(), 2), shiftType: 'Morning' })).body.error.code).toBe('SHIFT_NOT_STARTED');
    expect((await sa.post('/dev-console/badge-simulator/shift', { unitId: org.unitC.id, date: yesterday, shiftType: 'Night' })).body.error.code).toBe('NO_PUBLISHED_SHIFT');

    const view = await sa.get('/dev-console/badge-simulator');
    expect(view.body.enabled).toBe(true);
    expect(view.body.recent.every((e: { source: string }) => e.source === SIMULATOR_SOURCE)).toBe(true);
    expect(await db.auditEntry.count({ where: { action: 'BADGE_SIMULATED', priority: 'HIGH' } })).toBeGreaterThanOrEqual(2);

    const cleared = await sa.del('/dev-console/badge-simulator/events');
    expect(cleared.body.deleted).toBeGreaterThanOrEqual(3);
    expect(await db.attendanceEvent.count({ where: { source: SIMULATOR_SOURCE } })).toBe(0);
    expect((await hr.get('/dev-console/badge-simulator')).status).toBe(403);
  });

  it('BADGE_SIMULATOR=off: reads still work, nothing can be written', async () => {
    const off = testApp(db, { BADGE_SIMULATOR: 'off' });
    const admin = await signIn(off, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const { emp } = await makeNurse(db, org.unitA.id);
    expect((await admin.get('/dev-console/badge-simulator')).body.enabled).toBe(false);
    expect((await admin.post('/dev-console/badge-simulator/events', { jobNumber: emp.jobNumber, type: 'CLOCK_IN' })).body.error.code).toBe('BADGE_SIMULATOR_OFF');
  });

  it('an API client may hold attendance.ingest; the database refuses any other scope', async () => {
    const c = await sa.post('/api-clients', { name: uniq('PACS'), scopes: ['attendance.ingest', 'system/Practitioner.read'] });
    expect(c.body.client.scopes).toEqual(['attendance.ingest', 'system/Practitioner.read']);
    expect((await sa.post('/api-clients', { name: uniq('X'), scopes: ['attendance.write'] })).status).toBe(400);
    await expect(db.apiClient.update({ where: { id: c.body.client.id }, data: { scopes: ['attendance.write'] } })).rejects.toThrow();
  });
});
