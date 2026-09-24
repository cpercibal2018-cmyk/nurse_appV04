// Consistency auditor and business health (spec §10.8).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { auditEmployees, consistencyAudit, MIN_SAMPLE, sampleSize } from '../src/jobs/consistency-audit.js';
import { refreshEligibility } from '../src/modules/eligibility/state.service.js';
import { makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

describe('consistency audit sample size', () => {
  it('checks everyone in a small workforce, at least MIN_SAMPLE otherwise, and 1% of a large one', () => {
    expect([0, 30, MIN_SAMPLE, 51, 1000, 5000, 6000, 20_000].map(sampleSize)).toEqual([0, 30, 50, 50, 50, 50, 60, 200]);
  });
});

describeDb('consistency auditor (spec §10.8)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  beforeAll(async () => { db = openDb(); app = testApp(db); org = await makeOrg(db); });
  afterAll(async () => { await db.$disconnect(); });

  /** A nurse with a correct stored state. */
  async function nurse() {
    const { emp } = await makeNurse(db, org.unitA.id);
    await db.$transaction((tx) => refreshEligibility(tx, emp.id, 'TEST_SETUP'));
    return emp;
  }

  it('finds nothing when the stored state matches a fresh evaluation', async () => {
    const emp = await nurse();
    expect(await auditEmployees(db, [emp.id])).toEqual({ checked: 1, drifted: 0, missingState: 0, driftedEmployeeIds: [] });
    expect(await db.consistencyAuditLog.count({ where: { employeeId: emp.id } })).toBe(0);
  });

  it('corrects a wrong status, logs it and audits it HIGH', async () => {
    const emp = await nurse();
    const right = await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } });
    const wrong = right.status === 'INELIGIBLE' ? 'ELIGIBLE' : 'INELIGIBLE';
    await db.eligibilityState.update({ where: { employeeId: emp.id }, data: { status: wrong } });
    expect(await auditEmployees(db, [emp.id])).toMatchObject({ checked: 1, drifted: 1, missingState: 0 });
    expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } })).status).toBe(right.status);
    const log = await db.consistencyAuditLog.findFirstOrThrow({ where: { employeeId: emp.id } });
    expect(log).toMatchObject({ expectedStatus: right.status, actualStatus: wrong });
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'ELIGIBILITY_DRIFT_CORRECTED', resourceId: String(emp.id) } });
    expect(audit.priority).toBe('HIGH');
    expect(await auditEmployees(db, [emp.id])).toMatchObject({ drifted: 0 }); // fixed for good
  });

  it('treats different reasons with the same status as drift, and a missing state row too', async () => {
    const a = await nurse();
    await db.eligibilityState.update({ where: { employeeId: a.id }, data: { reasons: [{ code: 'WAIVER_ACTIVE', severity: 'INFO', message: 'stale' }] } });
    const b = await nurse();
    await db.eligibilityState.delete({ where: { employeeId: b.id } });
    expect(await auditEmployees(db, [a.id, b.id])).toMatchObject({ checked: 2, drifted: 2, missingState: 1, driftedEmployeeIds: [a.id, b.id] });
    expect(await db.eligibilityState.findUnique({ where: { employeeId: b.id } })).not.toBeNull();
    expect((await db.consistencyAuditLog.findFirstOrThrow({ where: { employeeId: b.id } })).actualStatus).toBeNull();
    expect(await auditEmployees(db, [a.id, b.id])).toMatchObject({ drifted: 0 });
  });

  it('the job tells System Admins once a day when it corrected anything', async () => {
    const admin = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    const emp = await nurse();
    await db.eligibilityState.delete({ where: { employeeId: emp.id } });
    const out = await consistencyAudit(db, new Date(), [emp.id]);
    expect(out).toMatchObject({ checked: 1, drifted: 1, missingState: 1 });
    expect(out.notified).toBeGreaterThan(0);
    const n = await db.notification.findFirstOrThrow({ where: { recipientId: admin.id, eventKey: { startsWith: 'consistency-audit:' } } });
    expect(n).toMatchObject({ type: 'SYSTEM', priority: 'HIGH' });
    const clean = await consistencyAudit(db, new Date(), [emp.id]);
    expect(clean).toMatchObject({ drifted: 0, notified: 0 });
  });

  it('GET /system/health/business reports drift, job freshness and e-mail delivery to System Admins only', async () => {
    const emp = await nurse();
    await db.eligibilityState.update({ where: { employeeId: emp.id }, data: { status: 'ELIGIBLE_WITH_POLICY_WARNING' } });
    await auditEmployees(db, [emp.id]);
    const recipient = await makeUser(db);
    await db.notification.create({ data: { recipientId: recipient.id, type: 'SYSTEM', title: 't', message: 'm', createdAt: new Date(Date.now() - 3600_000) } }); // PENDING for an hour

    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const res = await sa.get('/system/health/business');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ATTENTION');
    expect(res.body.eligibility.drifts7d).toBeGreaterThanOrEqual(1);
    expect(res.body.eligibility.recentDrifts.map((d: { employeeId: number }) => d.employeeId)).toContain(emp.id);
    expect(res.body.jobs.map((j: { name: string }) => j.name)).toEqual(['daily-transition', 'expiry-scan', 'attendance-alerts', 'consistency-audit']);
    expect(res.body.email.pendingOver15Minutes).toBeGreaterThanOrEqual(1);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('EMAIL_BACKLOG');

    const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hr.get('/system/health/business')).status).toBe(403);
  });
});
