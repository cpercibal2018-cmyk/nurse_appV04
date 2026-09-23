// Access control: permissions, scopes, role assignments, four-eyes, PAM,
// idempotency (rules R1–R13, R15; docs/FEATURE_MASTER_INVENTORY.md §15).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { findChainBreaks } from '../src/lib/audit.js';
import type { Db } from '../src/lib/prisma.js';
import { makeEmployee, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const REASON = 'Assigned as unit supervisor for the rota';

describeDb('access control', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
  });
  afterAll(async () => { await db.$disconnect(); });

  const hrSystem = () => makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
  const grant = (c: Awaited<ReturnType<typeof signIn>>, body: object, key = randomUUID()) =>
    c.post('/role-assignments', body).set('Idempotency-Key', key);

  describe('permissions (default deny, R15)', () => {
    it('lets HR list accounts and refuses supervisors and plain employees', async () => {
      const hr = await signIn(app, (await hrSystem()).email);
      expect((await hr.get('/users')).status).toBe(200);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await sup.get('/users')).body.error.code).toBe('FORBIDDEN');
      const emp = await signIn(app, (await makeUser(db)).email);
      expect((await emp.get('/users')).status).toBe(403);
      expect((await emp.get('/roles/matrix')).status).toBe(200); // reference data for everyone
    });

    it('a position never confers a role (R14): an NS-linked account with no assignment is an employee', async () => {
      await db.position.upsert({ where: { code: 'NS' }, update: {}, create: { code: 'NS', title: 'Nursing Supervisor', tier: 'Management', isSchedulable: false } });
      const emp = await db.employee.create({ data: { jobNumber: `NS${Date.now()}`, firstName: 'N', lastName: 'S', fullName: 'x', contactEmail: 'n@x.sa', positionCode: 'NS', unitId: org.unitA.id } });
      const c = await signIn(app, (await makeUser(db, { employeeId: emp.id })).email);
      expect((await c.get('/auth/me')).body.effectiveRoles).toEqual(['EMPLOYEE']);
      expect((await c.get('/role-assignments')).status).toBe(403);
    });
  });

  describe('PAM (R13)', () => {
    it('keeps System Admin dormant until elevated with a documented reason', async () => {
      const sa = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
      const c = await signIn(app, sa.email);
      expect((await c.get('/users')).body.error.code).toBe('PAM_ELEVATION_REQUIRED');
      expect((await c.get('/auth/me')).body.roles[0].dormant).toBe(true);
      expect((await c.post('/pam/elevate', { reason: 'short' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await c.post('/pam/elevate', { reason: 'Quarterly access review', durationHours: 5 })).status).toBe(400);
      const up = await c.post('/pam/elevate', { reason: 'Quarterly access review' });
      expect(up.status).toBe(200);
      expect(new Date(up.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(1.9 * 3600_000); // default 2 h
      expect((await c.get('/users')).status).toBe(200);
      expect((await c.post('/pam/end')).status).toBe(204);
      expect((await c.get('/users')).body.error.code).toBe('PAM_ELEVATION_REQUIRED');
    });

    it('ignores an expired elevation', async () => {
      const sa = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true });
      const c = await signIn(app, sa.email);
      expect((await c.get('/users')).status).toBe(200);
      await db.privilegedSession.update({ where: { userId: sa.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await c.get('/users')).status).toBe(403);
    });

    it('refuses elevation to users without a System Admin assignment', async () => {
      const c = await signIn(app, (await hrSystem()).email);
      expect((await c.post('/pam/elevate', { reason: 'I would like more power' })).body.error.code).toBe('NOT_SYSTEM_ADMIN');
    });
  });

  describe('granting roles (R2–R7)', () => {
    it('validates self-grant, reason length, scope shape and expiry window', async () => {
      const hr = await hrSystem();
      const c = await signIn(app, hr.email);
      const target = await makeUser(db);
      const base = { userId: target.id, role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id], reason: REASON };
      expect((await grant(c, { ...base, userId: hr.id })).body.error.code).toBe('SELF_GRANT_FORBIDDEN');
      expect((await grant(c, { ...base, reason: 'too short' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await grant(c, { ...base, role: 'EMPLOYEE' })).body.error.code).toBe('VALIDATION_FAILED'); // R1
      expect((await grant(c, { ...base, scopeType: 'SYSTEM' })).body.error.code).toBe('SCOPE_INVALID');
      expect((await grant(c, { ...base, scopeIds: [] })).body.error.code).toBe('SCOPE_INVALID');
      expect((await grant(c, { ...base, scopeIds: [2_000_000_000] })).body.error.code).toBe('SCOPE_TARGET_NOT_FOUND');
      const in91 = new Date(Date.now() + 91 * 86400_000).toISOString();
      expect((await grant(c, { ...base, expiresAt: in91 })).body.error.code).toBe('EXPIRY_INVALID');
      expect((await grant(c, { ...base, expiresAt: new Date(Date.now() - 1000).toISOString() })).body.error.code).toBe('EXPIRY_INVALID');
    });

    it('grants within scope, audits it, and refuses a second active grant of the same role and scope type (R7)', async () => {
      const c = await signIn(app, (await hrSystem()).email);
      const target = await makeUser(db);
      const ok = await grant(c, { userId: target.id, role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id], reason: REASON });
      expect(ok.status).toBe(201);
      expect(ok.body).toEqual({ status: 'GRANTED', id: expect.any(Number) });
      expect(await db.auditEntry.count({ where: { action: 'ROLE_GRANTED', resourceId: String(ok.body.id), priority: 'HIGH' } })).toBe(1);
      const dup = await grant(c, { userId: target.id, role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitB.id], reason: REASON });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('ROLE_ALREADY_ASSIGNED');
    });

    it('a department-scoped HR Admin grants only inside their department (R6)', async () => {
      const hr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'DEPARTMENT', scopeIds: [org.dept.id] }] });
      const c = await signIn(app, hr.email);
      const target = await makeUser(db);
      const inside = await grant(c, { userId: target.id, role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id, org.unitB.id], reason: REASON });
      expect(inside.status).toBe(201);
      const t2 = await makeUser(db);
      expect((await grant(c, { userId: t2.id, role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitC.id], reason: REASON })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await grant(c, { userId: t2.id, role: 'SUPERVISOR', scopeType: 'DEPARTMENT', scopeIds: [org.dept2.id], reason: REASON })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await grant(c, { userId: t2.id, role: 'SUPERVISOR', scopeType: 'SYSTEM', scopeIds: [], reason: REASON })).body.error.code).toBe('SCOPE_NOT_COVERED');
    });

    it('a unit-scoped HR Admin cannot grant a whole department even if it covers today\'s units', async () => {
      const hr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id, org.unitB.id] }] });
      const c = await signIn(app, hr.email);
      const t = await makeUser(db);
      expect((await grant(c, { userId: t.id, role: 'SUPERVISOR', scopeType: 'DEPARTMENT', scopeIds: [org.dept.id], reason: REASON })).body.error.code).toBe('SCOPE_NOT_COVERED');
    });

    it('a revocation takes effect on the very next request (R9)', async () => {
      const hr = await signIn(app, (await hrSystem()).email);
      const other = await signIn(app, (await hrSystem()).email);
      const targetUser = await makeUser(db);
      const g = await grant(hr, { userId: targetUser.id, role: 'HR_ADMIN', scopeType: 'DEPARTMENT', scopeIds: [org.dept.id], reason: REASON });
      const target = await signIn(app, targetUser.email);
      expect((await target.get('/users')).status).toBe(200);
      expect((await other.post(`/role-assignments/${g.body.id}/revoke`, { reason: 'Left the HR team' })).status).toBe(204);
      expect((await target.get('/users')).status).toBe(403);
    });

    it('no self-update or self-revoke (R2); revoke needs a reason of 10+ characters (R4)', async () => {
      const hr = await hrSystem();
      const c = await signIn(app, hr.email);
      const own = await db.roleAssignment.findFirstOrThrow({ where: { userId: hr.id } });
      expect((await c.post(`/role-assignments/${own.id}/revoke`, { reason: 'I quit this role' })).body.error.code).toBe('SELF_REVOKE_FORBIDDEN');
      expect((await c.patch(`/role-assignments/${own.id}`, { scopeType: 'DEPARTMENT', scopeIds: [org.dept.id], reason: REASON })).body.error.code).toBe('SELF_UPDATE_FORBIDDEN');
      const t = await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
      const a = await db.roleAssignment.findFirstOrThrow({ where: { userId: t.id } });
      expect((await c.post(`/role-assignments/${a.id}/revoke`, { reason: 'short' })).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('four-eyes (R10–R12)', () => {
    it('queues a System Admin promotion; the initiator cannot approve; a second admin executes it', async () => {
      const a = await signIn(app, (await hrSystem()).email);
      const b = await signIn(app, (await hrSystem()).email);
      const target = await makeUser(db);
      const pending = await grant(a, { userId: target.id, role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM', scopeIds: [], reason: REASON });
      expect(pending.status).toBe(202);
      expect(pending.body.status).toBe('PENDING_APPROVAL');
      const requestId = pending.body.requestId as number;
      expect(await db.roleAssignment.count({ where: { userId: target.id } })).toBe(0);

      expect((await grant(a, { userId: target.id, role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM', scopeIds: [], reason: REASON })).body.error.code).toBe('APPROVAL_ALREADY_PENDING');
      expect((await a.post(`/approvals/${requestId}/approve`, { reason: 'Looks fine' })).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect((await b.get('/approvals')).body.items.map((r: { id: number }) => r.id)).toContain(requestId);

      const done = await b.post(`/approvals/${requestId}/approve`, { reason: 'Verified with the DON' });
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('EXECUTED');
      const created = await db.roleAssignment.findFirstOrThrow({ where: { userId: target.id } });
      expect(created).toMatchObject({ role: 'SYSTEM_ADMIN', approvalRequestId: requestId });
      expect((await b.post(`/approvals/${requestId}/approve`, { reason: 'Again please' })).body.error.code).toBe('APPROVAL_NOT_PENDING');
      expect(await db.auditEntry.count({ where: { action: 'APPROVAL_EXECUTED', resourceId: String(requestId) } })).toBe(1);
    });

    it('queues system-wide HR Admin grants and HR scope upgrades to SYSTEM; rejection leaves nothing granted', async () => {
      const a = await signIn(app, (await hrSystem()).email);
      const b = await signIn(app, (await hrSystem()).email);
      const t1 = await makeUser(db);
      const p1 = await grant(a, { userId: t1.id, role: 'HR_ADMIN', scopeType: 'SYSTEM', scopeIds: [], reason: REASON });
      expect(p1.status).toBe(202);
      expect((await b.post(`/approvals/${p1.body.requestId}/reject`, { reason: 'Not agreed' })).body.status).toBe('REJECTED');
      expect(await db.roleAssignment.count({ where: { userId: t1.id } })).toBe(0);

      const t2 = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'DEPARTMENT', scopeIds: [org.dept.id] }] });
      const asg = await db.roleAssignment.findFirstOrThrow({ where: { userId: t2.id } });
      const up = await a.patch(`/role-assignments/${asg.id}`, { scopeType: 'SYSTEM', reason: 'Promoted to hospital-wide HR' });
      expect(up.status).toBe(202);
      await b.post(`/approvals/${up.body.requestId}/approve`, { reason: 'Approved by DON' });
      expect((await db.roleAssignment.findUniqueOrThrow({ where: { id: asg.id } })).scopeType).toBe('SYSTEM');
    });

    it('the approver cannot approve a grant to themselves (rules re-checked as the approver)', async () => {
      const a = await signIn(app, (await hrSystem()).email);
      const bUser = await hrSystem();
      const b = await signIn(app, bUser.email);
      const p = await grant(a, { userId: bUser.id, role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM', scopeIds: [], reason: REASON });
      expect((await b.post(`/approvals/${p.body.requestId}/approve`, { reason: 'Approve me' })).body.error.code).toBe('SELF_GRANT_FORBIDDEN');
      expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: p.body.requestId } })).status).toBe('PENDING');
    });
  });

  describe('last System Admin (R8)', () => {
    it('refuses to revoke the only remaining System Admin assignment', async () => {
      const hr = await signIn(app, (await hrSystem()).email);
      const sa = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
      const mine = await db.roleAssignment.findFirstOrThrow({ where: { userId: sa.id } });
      // Leave exactly one active System Admin in the (shared, disposable) test database.
      await db.roleAssignment.updateMany({ where: { role: 'SYSTEM_ADMIN', revokedAt: null, id: { not: mine.id } }, data: { revokedAt: new Date() } });
      const res = await hr.post(`/role-assignments/${mine.id}/revoke`, { reason: 'Clearing out admins' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LAST_SYSTEM_ADMIN');
    });
  });

  describe('idempotency', () => {
    it('replays the stored response for a repeated key, and refuses the key for a different request', async () => {
      const c = await signIn(app, (await hrSystem()).email);
      const target = await makeUser(db);
      const key = randomUUID();
      const body = { userId: target.id, role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitB.id], reason: REASON };
      const first = await grant(c, body, key);
      const again = await grant(c, body, key);
      expect(again.status).toBe(first.status);
      expect(again.body).toEqual(first.body);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(await db.roleAssignment.count({ where: { userId: target.id } })).toBe(1);
      expect((await grant(c, { ...body, scopeIds: [org.unitA.id] }, key)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await c.post('/role-assignments', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });
  });

  describe('accounts', () => {
    it('scoped HR sees and provisions accounts only for employees in scope', async () => {
      const hr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
      const c = await signIn(app, hr.email);
      const inA = await makeEmployee(db, org.unitA.id);
      const inC = await makeEmployee(db, org.unitC.id);
      const create = (employeeId: number | null) => c.post('/users', { email: `acc${employeeId}-${Date.now()}@test.aigh.sa`, displayName: 'New Nurse', password: 'initial-password-123', employeeId }).set('Idempotency-Key', randomUUID());

      const ok = await create(inA.id);
      expect(ok.status).toBe(201);
      expect(Object.keys(ok.body)).toEqual(['id']); // identifiers only (idempotency store holds no PII)
      expect((await create(inC.id)).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await create(null)).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await create(inA.id)).body.error.code).toBe('EMPLOYEE_ALREADY_LINKED');

      const list = await c.get('/users');
      expect(list.body.items.map((u: { id: number }) => u.id)).toContain(ok.body.id);
      expect(list.body.items.every((u: { employee: { unitId: number } | null }) => u.employee?.unitId === org.unitA.id)).toBe(true);
    });

    it('rejects weak initial passwords and duplicate emails; deactivation ends sessions; no self-deactivation', async () => {
      const hr = await hrSystem();
      const c = await signIn(app, hr.email);
      const post = (body: object) => c.post('/users', body).set('Idempotency-Key', randomUUID());
      expect((await post({ email: `w${Date.now()}@test.aigh.sa`, displayName: 'W', password: 'short' })).body.error.code).toBe('VALIDATION_FAILED');
      const email = `dup${Date.now()}@test.aigh.sa`;
      const made = await post({ email, displayName: 'D', password: 'initial-password-123' });
      expect((await post({ email: email.toUpperCase(), displayName: 'D', password: 'initial-password-123' })).body.error.code).toBe('EMAIL_TAKEN');

      const victim = await signIn(app, email, 'initial-password-123');
      expect((await c.patch(`/users/${made.body.id}`, { isActive: false })).status).toBe(200);
      expect((await victim.get('/auth/me')).status).toBe(401);
      expect((await c.patch(`/users/${hr.id}`, { isActive: false })).body.error.code).toBe('SELF_DEACTIVATION_FORBIDDEN');
    });
  });

  it('leaves the audit chain intact', async () => {
    expect(await findChainBreaks(db)).toEqual([]);
  });
});
