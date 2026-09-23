// Workforce, employee master and contracts through the HTTP API against
// PostgreSQL: rules W1–W8 (org structure, beds, positions, coverage), E1–E10
// (onboarding, views, position), C1–C11 and owner decisions D-3, D-29, D-30.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { findChainBreaks } from '../src/lib/audit.js';
import { addDays, riyadhDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { FILES, makeEmployee, makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const today = () => riyadhDate();
type Client = Awaited<ReturnType<typeof signIn>>;
const idem = <T extends { set: (k: string, v: string) => T }>(req: T) => req.set('Idempotency-Key', randomUUID());

describeDb('workforce, employees and contracts', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Client; // system-wide HR
  let hr2: Client; // a second system-wide HR (approver)
  let scoped: Client; // HR for unit A only

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    hr2 = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    scoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  describe('organisation structure (W1–W3)', () => {
    it('only system-wide HR changes departments and units; deactivation guards hold', async () => {
      const code = uniq('D').toUpperCase().slice(0, 20);
      expect((await scoped.post('/departments', { code, name: 'Scoped try' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      const dept = await hr.post('/departments', { code, name: 'New department' });
      expect(dept.status).toBe(201);
      expect((await hr.post('/departments', { code, name: 'Again' })).body.error.code).toBe('DEPARTMENT_EXISTS');

      const unitCode = uniq('U').toUpperCase().slice(0, 20);
      const unit = await hr.post('/units', { code: unitCode, name: 'New unit', departmentId: dept.body.id, bedCount: 12 });
      expect(unit.status).toBe(201);
      expect(await db.bedCapacityLog.count({ where: { unitId: unit.body.id, newCount: 12 } })).toBe(1);

      expect((await hr.patch(`/departments/${dept.body.id}`, { isActive: false })).body.error.code).toBe('DEPARTMENT_HAS_ACTIVE_UNITS');
      await makeEmployee(db, unit.body.id);
      expect((await hr.patch(`/units/${unit.body.id}`, { isActive: false })).body.error.code).toBe('UNIT_HAS_ACTIVE_EMPLOYEES');

      const summary = await hr.get('/units/summary');
      expect(summary.body.totalBeds).toBe(summary.body.byDepartment.reduce((s: number, d: { beds: number }) => s + d.beds, 0));
    });
  });

  describe('bed capacity (W4, W5)', () => {
    it('a single change needs a reason, follows unit scope and is logged before → after', async () => {
      expect((await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: 20 })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: 501, reason: 'Expansion' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await scoped.put(`/units/${org.unitC.id}/bed-capacity`, { bedCount: 5, reason: 'Expansion' })).body.error.code).toBe('SCOPE_NOT_COVERED');
      const before = (await db.unit.findUniqueOrThrow({ where: { id: org.unitA.id } })).bedCount;
      const done = await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: before + 4, reason: 'Ward expansion' });
      expect(done.body).toMatchObject({ status: 'UPDATED', previous: before, bedCount: before + 4 });
      expect((await scoped.put(`/units/${org.unitA.id}/bed-capacity`, { bedCount: before + 4, reason: 'Again' })).body.status).toBe('UNCHANGED');
      const log = await db.bedCapacityLog.findFirstOrThrow({ where: { unitId: org.unitA.id }, orderBy: { id: 'desc' } });
      expect(log).toMatchObject({ previousCount: before, newCount: before + 4, reason: 'Ward expansion' });
      const history = await scoped.get(`/units/${org.unitA.id}/bed-history`);
      expect(history.body.items[0].changedBy).toBe('Test User');
    });

    it('bulk reports each row and needs an Idempotency-Key', async () => {
      const body = {
        reason: 'Annual re-baseline',
        rows: [
          { unitCode: org.unitA.code, bedCount: 7 }, { unitCode: org.unitC.code, bedCount: 7 },
          { unitCode: 'NO_SUCH_UNIT', bedCount: 7 }, { unitCode: org.unitA.code, bedCount: 8 }, { unitCode: org.unitB.code, bedCount: 2.5 },
        ],
      };
      expect((await scoped.put('/units/bed-capacity/bulk', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const res = await idem(scoped.put('/units/bed-capacity/bulk', body));
      expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['UPDATED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
      expect(res.body.results[1].reason).toBe('Outside your assigned scope');
      expect((await db.unit.findUniqueOrThrow({ where: { id: org.unitA.id } })).bedCount).toBe(7);
    });
  });

  describe('CSV import', () => {
    it('dry run changes nothing; applying creates and updates with logs; quoted fields work', async () => {
      const newCode = uniq('IMP').toUpperCase().slice(0, 20);
      const csv = [
        'unit_code,name,department_code,beds,description',
        `${newCode},"Ward, East",${org.dept.code},14,"New ""east"" ward"`,
        `${org.unitB.code},Unit B renamed,${org.dept.code},9,`,
        `BAD CODE,Nope,${org.dept.code},1,`,
        `${newCode},Duplicate,${org.dept.code},1,`,
        `${uniq('X').toUpperCase().slice(0, 20)},No dept,NOPE,1,`,
      ].join('\n');
      expect((await scoped.post('/units/import', { csv })).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await idem(scoped.post('/units/import', { csv }))).body.error.code).toBe('SCOPE_NOT_COVERED');
      const dry = await idem(hr.post('/units/import', { csv }));
      expect(dry.body).toMatchObject({ dryRun: true, created: 1, updated: 1, rejected: 3 });
      expect(await db.unit.findUnique({ where: { code: newCode } })).toBeNull();

      const applied = await idem(hr.post('/units/import', { csv, dryRun: false }));
      expect(applied.body).toMatchObject({ dryRun: false, created: 1, updated: 1 });
      const created = await db.unit.findUniqueOrThrow({ where: { code: newCode } });
      expect(created).toMatchObject({ name: 'Ward, East', description: 'New "east" ward', bedCount: 14 });
      expect((await db.unit.findUniqueOrThrow({ where: { id: org.unitB.id } })).bedCount).toBe(9);
      expect(await db.bedCapacityLog.count({ where: { unitId: org.unitB.id, newCount: 9, reason: 'CSV import: bed capacity' } })).toBe(1);
      expect((await idem(hr.post('/units/import', { csv: 'unit_code,name\nX,Y' }))).body.error.code).toBe('CSV_INVALID');
    });
  });

  describe('positions (W6, W7) and coverage targets (W8)', () => {
    it('a held position cannot be deactivated; turning off schedulability re-evaluates holders', async () => {
      const code = uniq('P').toUpperCase().slice(0, 20);
      expect((await hr.post('/positions', { code, title: 'Test position', tier: 'Clinical', isSchedulable: true })).status).toBe(201);
      expect((await hr.post('/positions', { code: uniq('P').toUpperCase().slice(0, 20), title: 'Bad tier', tier: 'Imaginary', isSchedulable: true })).body.error.code).toBe('VALIDATION_FAILED');
      const { emp } = await makeNurse(db, org.unitA.id);
      await db.employee.update({ where: { id: emp.id }, data: { positionCode: code } });
      expect((await hr.patch(`/positions/${code}`, { isActive: false })).body.error.code).toBe('POSITION_IN_USE');
      await hr.patch(`/positions/${code}`, { isSchedulable: false });
      const state = await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } });
      expect(state.status).toBe('INELIGIBLE');
      expect(JSON.stringify(state.reasons)).toContain('POSITION_NOT_SCHEDULABLE');
    });

    it('a target can be set and removed (unspecified, never zero), within unit scope', async () => {
      expect((await scoped.put('/coverage-targets', { unitId: org.unitC.id, shiftType: 'Night', minimumStaff: 3 })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await scoped.put('/coverage-targets', { unitId: org.unitA.id, shiftType: 'Night', minimumStaff: 3 })).body.minimumStaff).toBe(3);
      expect((await hr.get(`/coverage-targets?unitId=${org.unitA.id}`)).body.items).toHaveLength(1);
      expect((await scoped.put('/coverage-targets', { unitId: org.unitA.id, shiftType: 'Night', minimumStaff: null })).body.minimumStaff).toBeNull();
      expect((await hr.get(`/coverage-targets?unitId=${org.unitA.id}`)).body.items).toHaveLength(0);
    });

    it('the KPI answers with bands and says its thresholds are not sourced in the repository (D-11)', async () => {
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const res = await sup.get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`);
      expect(res.status).toBe(200);
      expect(res.body.kpiA.areas).toHaveLength(3);
      expect(res.body.thresholdSource).toMatch(/not in the repository/);

      // KPI A areas come from units.critical_area, set by system-wide HR — not from unit codes in the code.
      const icu = await hr.post('/units', { code: uniq('KICU').toUpperCase().slice(0, 20), name: 'KPI ICU', departmentId: org.dept.id, bedCount: 4, criticalArea: 'ICU' });
      expect(icu.body.criticalArea).toBe('ICU');
      const withIcu = await sup.get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`);
      expect(withIcu.body.areaUnits[icu.body.code]).toBe('ICU');
      expect(withIcu.body.kpiA.areas.find((a: { area: string }) => a.area === 'ICU').beds).toBe(res.body.kpiA.areas.find((a: { area: string }) => a.area === 'ICU').beds + 4);
      expect((await hr.patch(`/units/${icu.body.id}`, { criticalArea: null })).body.criticalArea).toBeNull();
      expect((await sup.get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`)).body.areaUnits[icu.body.code]).toBeUndefined();
      expect((await (await signIn(app, (await makeUser(db)).email)).get(`/kpi/nurse-to-bed?date=${today()}&shift=Morning`)).status).toBe(403);
    });
  });

  describe('onboarding (E1–E10, D-3)', () => {
    const onboardBody = (over: object = {}) => ({
      jobNumber: uniq('OB'), firstName: ' Mona ', middleName: '', lastName: 'Saleh', contactEmail: 'Mona@Example.SA',
      unitId: org.unitA.id, salary: '12500.50', maritalStatus: 'Single',
      contractStart: today(), contractEnd: addDays(today(), 364), ...over,
    });

    it('rule E6: the server supplies the default position; omitting it at onboarding uses it (P4)', async () => {
      expect((await scoped.get('/employees/onboarding-defaults')).body).toEqual({ unitId: null, positionCode: 'SN', rule: 'E6' });
      const nurse = await signIn(app, (await makeUser(db)).email);
      expect((await nurse.get('/employees/onboarding-defaults')).status).toBe(403);
      const body = onboardBody(); // no positionCode
      const res = await idem(scoped.post('/employees/onboard', body));
      expect(res.status).toBe(201);
      expect((await db.employee.findUniqueOrThrow({ where: { id: res.body.employeeId } })).positionCode).toBe('SN');
    });

    it('creates the employee, a Draft contract with Hijri dates, an audit row and an INELIGIBLE state atomically', async () => {
      const body = onboardBody();
      expect((await scoped.post('/employees/onboard', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const key = randomUUID();
      const res = await scoped.post('/employees/onboard', body).set('Idempotency-Key', key);
      expect(res.status).toBe(201);
      const replay = await scoped.post('/employees/onboard', body).set('Idempotency-Key', key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(res.body);

      const emp = await db.employee.findUniqueOrThrow({ where: { id: res.body.employeeId } });
      expect(emp).toMatchObject({ fullName: 'Mona Saleh', positionCode: 'SN', contactEmail: 'mona@example.sa' });
      const contract = await db.contract.findUniqueOrThrow({ where: { id: res.body.contractId } });
      expect(contract.status).toBe('Draft');
      expect(contract.startDateHijri).toMatch(/^14\d\d-\d\d-\d\d$/);
      const state = await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } });
      expect(JSON.stringify(state.reasons)).toContain('NO_CONTRACT_COVERAGE');
      expect(await db.auditEntry.count({ where: { action: 'EMPLOYEE_ONBOARDED', resourceId: String(emp.id) } })).toBe(1);
    });

    it('rolls back everything on a duplicate job number (any case) and guards scope', async () => {
      const jobNumber = uniq('DUP');
      await idem(hr.post('/employees/onboard', onboardBody({ jobNumber })));
      const before = await db.contract.count();
      const dup = await idem(hr.post('/employees/onboard', onboardBody({ jobNumber: jobNumber.toLowerCase() })));
      expect(dup.body.error.code).toBe('JOB_NUMBER_TAKEN');
      expect(await db.contract.count()).toBe(before);
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ unitId: null })))).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await idem(scoped.post('/employees/onboard', onboardBody({ unitId: org.unitC.id })))).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await idem(hr.post('/employees/onboard', onboardBody({ contractEnd: today() })))).body.error.code).toBe('CONTRACT_DATES_INVALID');
      expect((await idem(hr.post('/employees/onboard', onboardBody({ salary: -1 })))).body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('employee views and changes (§8.1, E9)', () => {
    it('HR sees every field, a Supervisor the baseline (D-36), the employee their own profile', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      await db.employee.update({
        where: { id: emp.id },
        data: { salary: 9000, nationality: 'SA', maritalStatus: 'Married', rankGrade: 'G5', fileNo: 'F-77', jobPostLocation: 'Post A', actualWorkPlace: 'Ward 3', primaryPhone: '+966501234567', emergencyContactPhone: '+639171234567' },
      });
      expect((await hr.get(`/employees/${emp.id}`)).body).toMatchObject({ view: 'FULL', salary: '9000.00', nationality: 'SA', emergencyContactPhone: '+639171234567' });
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const seen = await sup.get(`/employees/${emp.id}`);
      expect(seen.body).toMatchObject({ view: 'BASELINE', contactEmail: emp.contactEmail, primaryPhone: '+966501234567', actualWorkPlace: 'Ward 3' });
      for (const hidden of ['salary', 'maritalStatus', 'nationality', 'rankGrade', 'fileNo', 'jobPostLocation', 'emergencyContactPhone']) {
        expect(seen.body, hidden).not.toHaveProperty(hidden);
      }
      const listed = (await sup.get(`/employees?unitId=${org.unitA.id}`)).body.items;
      expect(listed.every((e: { view: string }) => e.view === 'BASELINE')).toBe(true);
      const outside = await makeEmployee(db, org.unitC.id);
      expect((await sup.get(`/employees/${outside.id}`)).status).toBe(403);
      const self = await signIn(app, user!.email);
      expect((await self.get('/employees/me')).body).toMatchObject({ id: emp.id, view: 'FULL' });
      expect((await self.get('/employees')).status).toBe(403);
    });

    it('a unit move re-evaluates eligibility; position change is HR_ADMIN only and audited', async () => {
      const emp = await makeEmployee(db, org.unitA.id);
      expect((await scoped.patch(`/employees/${emp.id}`, { unitId: org.unitC.id })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.patch(`/employees/${emp.id}`, { unitId: org.unitB.id, fileNo: 'F-1' })).body).toMatchObject({ unitId: org.unitB.id, fileNo: 'F-1', firstName: 'Test' });
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } })).updatedByEvent).toBe('EMPLOYEE_UNIT_CHANGED');

      await db.position.upsert({ where: { code: 'CN' }, update: { isActive: true }, create: { code: 'CN', title: 'Charge Nurse', tier: 'Clinical Lead', isSchedulable: true } });
      const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
      expect((await sa.post(`/employees/${emp.id}/position`, { positionCode: 'CN', reason: 'Promotion' })).status).toBe(403);
      expect((await hr.post(`/employees/${emp.id}/position`, { positionCode: 'SN', reason: 'No change' })).body.error.code).toBe('POSITION_UNCHANGED');
      expect((await hr.post(`/employees/${emp.id}/position`, { positionCode: 'CN', reason: 'Promotion' })).body.positionCode).toBe('CN');
      expect(await db.auditEntry.count({ where: { action: 'EMPLOYEE_POSITION_CHANGED', resourceId: String(emp.id) } })).toBe(1);

      expect((await hr.del(`/employees/${emp.id}`).send({ reason: 'Left the hospital' })).body.deleted).toBe(true);
      expect((await hr.get(`/employees/${emp.id}`)).status).toBe(404);
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } })).status).toBe('INELIGIBLE');
    });
  });

  describe('own phone numbers (D-35)', () => {
    it('the employee updates only their phones, in international format; HR too; the next-of-kin number stays out of the audit', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      const self = await signIn(app, user!.email);
      const ok = await self.patch('/employees/me/contact', { primaryPhone: '+966 50-123-4567', emergencyContactPhone: '+44 (20) 7946 0958' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: emp.id, primaryPhone: '+966501234567', emergencyContactPhone: '+442079460958' });
      for (const bad of ['0501234567', '+0501234567', '+1234567', '+9665012345678901', 'call me']) {
        expect((await self.patch('/employees/me/contact', { primaryPhone: bad })).body.error.code, bad).toBe('VALIDATION_FAILED');
      }
      expect((await self.patch('/employees/me/contact', { salary: '1' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await self.patch('/employees/me/contact', {})).body.error.code).toBe('NO_CHANGES');
      expect((await self.patch('/employees/me/contact', { emergencyContactPhone: null })).body.emergencyContactPhone).toBeNull();

      const audit = await db.auditEntry.findMany({ where: { action: 'EMPLOYEE_CONTACT_UPDATED', resourceId: String(emp.id) }, orderBy: { id: 'asc' } });
      expect(audit[0]!.changes).toMatchObject({ primaryPhone: { from: null, to: '+966501234567' }, emergencyContactPhone: { from: '(redacted)', to: '(redacted)' } });
      expect(JSON.stringify(audit.map((a) => a.changes))).not.toContain('442079460958');

      expect((await hr.patch(`/employees/${emp.id}`, { primaryPhone: '+639171234567' })).body.primaryPhone).toBe('+639171234567');
      await expect(db.employee.update({ where: { id: emp.id }, data: { primaryPhone: '0501234567' } })).rejects.toThrow(); // database CHECK
      const unlinked = await signIn(app, (await makeUser(db)).email);
      expect((await unlinked.patch('/employees/me/contact', { primaryPhone: '+966501234567' })).body.error.code).toBe('NO_EMPLOYEE_RECORD');
    });
  });

  describe('unauthorized access sweep (R15)', () => {
    const STAFF_ONLY: Array<[string, string]> = [
      ['POST', '/departments'], ['PATCH', '/departments/1'], ['POST', '/units'], ['PATCH', '/units/1'],
      ['PUT', '/units/1/bed-capacity'], ['PUT', '/units/bed-capacity/bulk'], ['POST', '/units/import'], ['GET', '/units/1/bed-history'],
      ['POST', '/positions'], ['PATCH', '/positions/SN'], ['PUT', '/coverage-targets'], ['GET', '/kpi/nurse-to-bed?date=2026-01-01&shift=Night'],
      ['GET', '/employees'], ['POST', '/employees/onboard'], ['PATCH', '/employees/1'], ['POST', '/employees/1/position'], ['DELETE', '/employees/1'],
      ['GET', '/contracts'], ['GET', '/contracts/creatable'], ['GET', '/contracts/renewable'], ['POST', '/contracts'],
      ['POST', '/contracts/1/renew'], ['POST', '/contracts/1/transition'], ['POST', '/contracts/1/documents'],
    ];
    it.each(STAFF_ONLY)('%s %s is forbidden to an employee', async (method, path) => {
      const nurse = await signIn(app, (await makeUser(db)).email);
      const req = method === 'GET' ? nurse.get(path) : method === 'POST' ? nurse.post(path, {}) : method === 'PUT' ? nurse.put(path, {}) : method === 'PATCH' ? nurse.patch(path, {}) : nurse.del(path);
      expect((await req.set('Idempotency-Key', randomUUID())).status).toBe(403);
    });

    it('a nurse reads only their own record and contracts', async () => {
      const { user } = await makeNurse(db, org.unitA.id, { account: true });
      const other = await makeNurse(db, org.unitA.id);
      const nurse = await signIn(app, user!.email);
      expect((await nurse.get(`/employees/${other.emp.id}`)).status).toBe(403);
      const theirs = await db.contract.findFirstOrThrow({ where: { employeeId: other.emp.id } });
      expect((await nurse.get(`/contracts/${theirs.id}`)).status).toBe(403);
      expect((await nurse.get(`/contracts/${theirs.id}/documents`)).status).toBe(403);
    });
  });

  describe('contracts (C1–C11, D-29, D-30)', () => {
    async function draftFor(creator: Client, start = today(), end = addDays(today(), 364)) {
      const emp = await makeEmployee(db, org.unitA.id);
      const made = await idem(creator.post('/contracts', { employeeId: emp.id, startDate: start, endDate: end }));
      expect(made.status).toBe(201);
      return { emp, id: made.body.id as number };
    }
    const act = (c: Client, id: number, action: string, reason?: string) => c.post(`/contracts/${id}/transition`, { action, ...(reason ? { reason } : {}) });

    it('Draft → submit (needs a copy) → approve by someone else → Active, with eligibility', async () => {
      const { emp, id } = await draftFor(hr);
      expect((await act(hr, id, 'approve')).body.error.code).toBe('TRANSITION_NOT_ALLOWED');
      expect((await act(hr, id, 'submit')).body.error.code).toBe('CONTRACT_COPY_REQUIRED');
      expect((await hr.upload(`/contracts/${id}/documents`, FILES.png, 'image/png', 'copy.png')).status).toBe(415);
      expect((await hr.upload(`/contracts/${id}/documents`, FILES.pdf, 'application/pdf', 'copy.pdf')).status).toBe(201);
      expect((await act(hr, id, 'submit')).body.status).toBe('PendingApproval');
      expect((await act(hr, id, 'approve')).body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
      const approved = await act(hr2, id, 'approve');
      expect(approved.body).toMatchObject({ status: 'Active', eligibility: 'ELIGIBLE' });
      expect((await db.contract.findUniqueOrThrow({ where: { id } })).approvedAt).not.toBeNull();

      expect((await act(hr, id, 'suspend')).body.error.code).toBe('VALIDATION_FAILED');
      expect((await act(hr, id, 'suspend', 'Investigation pending')).body).toMatchObject({ status: 'Suspended', eligibility: 'INELIGIBLE' });
      expect((await act(hr, id, 'reinstate', 'Investigation closed')).body.status).toBe('Active');
      expect((await act(hr, id, 'terminate', 'Resigned with notice')).body.status).toBe('Terminated');
      expect((await act(hr, id, 'reinstate', 'Try again')).body.error.code).toBe('TRANSITION_NOT_ALLOWED');
      expect((await db.eligibilityState.findUniqueOrThrow({ where: { employeeId: emp.id } })).status).toBe('INELIGIBLE');
    });

    it('a future period is Approved (C2); an overlapping renewal cannot be approved (C4); return goes back to Draft', async () => {
      const { emp, id } = await draftFor(hr);
      await hr.upload(`/contracts/${id}/documents`, FILES.pdf, 'application/pdf');
      await act(hr, id, 'submit');
      await act(hr2, id, 'approve');
      expect((await idem(hr.post('/contracts', { employeeId: emp.id, startDate: today(), endDate: addDays(today(), 10) }))).body.error.code).toBe('EMPLOYEE_HAS_CONTRACT');

      // The picker lists at most 500 employees; read it through HR scoped to a unit of its own so the shared test database cannot push this one out.
      const own = await db.unit.create({ data: { code: uniq('RN').toUpperCase().slice(0, 20), name: 'Renewal unit', departmentId: org.dept.id } });
      await db.employee.update({ where: { id: emp.id }, data: { unitId: own.id } });
      const unitHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [own.id] }] })).email);
      const renewable = (await unitHr.get('/contracts/renewable')).body.items.find((r: { employeeId: number }) => r.employeeId === emp.id);
      expect(renewable.prefill.start).toBe(addDays(today(), 365));
      const next = await idem(hr.post(`/contracts/${id}/renew`, {}));
      await hr.upload(`/contracts/${next.body.id}/documents`, FILES.pdf, 'application/pdf');
      await act(hr, next.body.id, 'submit');
      expect((await act(hr, next.body.id, 'return', 'Wrong grade on page 2')).body.status).toBe('Draft');
      await act(hr, next.body.id, 'submit');
      expect((await act(hr2, next.body.id, 'approve')).body.status).toBe('Approved');

      const overlapping = await idem(hr.post(`/contracts/${next.body.id}/renew`, { startDate: addDays(today(), 400), endDate: addDays(today(), 500) }));
      await hr.upload(`/contracts/${overlapping.body.id}/documents`, FILES.pdf, 'application/pdf');
      await act(hr, overlapping.body.id, 'submit');
      expect((await act(hr2, overlapping.body.id, 'approve')).body.error.code).toBe('CONTRACT_PERIOD_OVERLAP');
    });

    it('scope, own-contract and view rules', async () => {
      const { emp, id } = await draftFor(hr);
      expect((await idem(scoped.post('/contracts', { employeeId: (await makeEmployee(db, org.unitC.id)).id, startDate: today(), endDate: addDays(today(), 30) }))).body.error.code).toBe('SCOPE_NOT_COVERED');

      // An HR Admin who is also a nurse cannot manage their own contract.
      const selfHr = await makeUser(db, { employeeId: emp.id, roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
      const selfClient = await signIn(app, selfHr.email);
      expect((await act(selfClient, id, 'submit')).body.error.code).toBe('SELF_ACTION_FORBIDDEN');
      expect((await selfClient.get('/contracts/me')).body.items[0]).toMatchObject({ id, view: 'REDUCED' });

      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const row = (await sup.get(`/contracts?employeeId=${emp.id}`)).body.items[0];
      expect(row.view).toBe('REDUCED');
      expect(row).not.toHaveProperty('createdById');
      expect((await sup.get(`/contracts/${id}/documents`)).status).toBe(403);
      expect((await sup.post(`/contracts/${id}/transition`, { action: 'submit' })).status).toBe(403);
      expect((await findChainBreaks(db))).toHaveLength(0);
    });
  });
});
