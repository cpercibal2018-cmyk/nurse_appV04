// Credentials and clinical eligibility through the HTTP API against PostgreSQL:
// spec §5.1.4 (requirements), §5.1.5 / §5.3 (evidence, D1–D5), §5.2 (lifecycle,
// L1–L3), §6.1 (materialized state, L6), §6.1.1 grace (L8), §6.1.1.1 transitions
// (L10), §6.1.2 waivers (L9), §8.1 Credentials row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { findChainBreaks } from '../src/lib/audit.js';
import { addDays, riyadhDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { FILES, makeNurse, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const today = () => riyadhDate();
const fields = (issue: string, expiry: string) => ({ trackingData: { licence_number: 'L-123', issue_date: issue, expiry_date: expiry } });

describeDb('credentials and eligibility', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  type StoredReason = { code: string; severity: string; templateId?: number; until?: string };
  const state = async (employeeId: number) => {
    const s = await db.eligibilityState.findUnique({ where: { employeeId } });
    return s && { ...s, reasons: s.reasons as StoredReason[] };
  };
  const require = (templateId: number, unitId: number, extra: object = {}) => hr.post('/credential-requirements', { templateId, unitId, ...extra });
  /** Records, uploads evidence and verifies a credential for a nurse. Returns its id. */
  async function validCredential(employeeId: number, templateId: number, issue = addDays(today(), -30), expiry = addDays(today(), 365)) {
    const rec = await hr.post('/credentials', { employeeId, templateId, ...fields(issue, expiry) });
    expect(rec.status).toBe(201);
    expect((await hr.upload(`/credentials/${rec.body.id}/documents`, FILES.pdf, 'application/pdf')).status).toBe(201);
    expect((await hr.post(`/credentials/${rec.body.id}/verify`)).status).toBe(200);
    return rec.body.id as number;
  }

  describe('requirements drive the materialized state in the same transaction (§5.1.4, L6)', () => {
    it('adding a MANDATORY rule makes a nurse without it INELIGIBLE at once; deleting it restores ELIGIBLE (D-4)', async () => {
      const unit = await db.unit.create({ data: { code: `RQ${Date.now()}`, name: 'Req unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      const made = await require(tpl.id, unit.id);
      expect(made.status).toBe(201);
      expect(made.body.affectedEmployees).toBe(1);
      const s1 = await state(emp.id);
      expect(s1?.status).toBe('INELIGIBLE');
      expect(s1?.reasons).toEqual([expect.objectContaining({ code: 'CREDENTIAL_MISSING', templateId: tpl.id })]);
      expect((await hr.del(`/credential-requirements/${made.body.id}`)).status).toBe(200);
      const s2 = await state(emp.id);
      expect(s2?.status).toBe('ELIGIBLE');
      expect(s2?.reasons).toEqual([expect.objectContaining({ code: 'NO_REQUIREMENTS_CONFIGURED', severity: 'INFO' })]);
      expect(await db.auditEntry.count({ where: { action: { in: ['REQUIREMENT_CREATED', 'REQUIREMENT_DELETED'] }, resourceId: String(made.body.id), priority: 'HIGH' } })).toBe(2);
    });

    it('validates targets and transition deadlines; the same rule cannot exist twice', async () => {
      const tpl = await makeTemplate(db);
      expect((await require(tpl.id, org.unitA.id, { policyStatus: 'TRANSITION' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await require(tpl.id, org.unitA.id, { transitionDeadline: '2030-01-01' })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await require(tpl.id, 2_000_000_000)).body.error.code).toBe('UNIT_NOT_FOUND');
      expect((await require(tpl.id, org.unitA.id, { positionCode: 'NOPE' })).body.error.code).toBe('POSITION_NOT_FOUND');
      expect((await require(tpl.id, org.unitA.id)).status).toBe(201);
      expect((await require(tpl.id, org.unitA.id)).body.error.code).toBe('REQUIREMENT_EXISTS');
    });

    it('scope: a unit-scoped HR admin manages rules only for their units; supervisors cannot write rules', async () => {
      const tpl = await makeTemplate(db);
      const scoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await scoped.post('/credential-requirements', { templateId: tpl.id, unitId: org.unitB.id })).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await scoped.post('/credential-requirements', { templateId: tpl.id, unitId: org.unitA.id })).status).toBe(201);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await sup.post('/credential-requirements', { templateId: tpl.id, unitId: org.unitB.id })).body.error.code).toBe('FORBIDDEN');
      expect((await sup.get('/credential-requirements')).status).toBe(200);
    });

    it('bulk set applies all entries in one transaction and refreshes the units', async () => {
      const unit = await db.unit.create({ data: { code: `BK${Date.now()}`, name: 'Bulk unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const [t1, t2] = [await makeTemplate(db), await makeTemplate(db)];
      const res = await hr.post('/credential-requirements/bulk', { items: [{ templateId: t1.id, unitId: unit.id }, { templateId: t2.id, unitId: unit.id, positionCode: 'SN' }] });
      expect(res.body).toMatchObject({ created: 2, updated: 0, affectedEmployees: 1 });
      expect((await state(emp.id))?.reasons).toHaveLength(2);
    });
  });

  describe('verification lifecycle (§5.2, L1–L3)', () => {
    it('record → evidence → verify makes the nurse ELIGIBLE; verification needs evidence when the template requires it', async () => {
      const unit = await db.unit.create({ data: { code: `VL${Date.now()}`, name: 'Lifecycle unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      await require(tpl.id, unit.id);
      const rec = await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, ...fields(addDays(today(), -10), addDays(today(), 400)) });
      expect(rec.status).toBe(201);
      expect((await state(emp.id))?.reasons[0]).toMatchObject({ code: 'CREDENTIAL_NOT_VERIFIED' });
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).body.error.code).toBe('EVIDENCE_REQUIRED');
      const up = await hr.upload(`/credentials/${rec.body.id}/documents`, FILES.pdf, 'application/pdf', 'licence.pdf');
      expect(up.status).toBe(201);
      const v = await hr.post(`/credentials/${rec.body.id}/verify`);
      expect(v.body).toEqual({ id: rec.body.id, status: 'Valid' });
      const stored = await db.credential.findUniqueOrThrow({ where: { id: rec.body.id } });
      expect(stored.latestEvidenceId).toBe(up.body.id);
      expect((await db.documentVersion.findUniqueOrThrow({ where: { id: up.body.id } })).reviewStatus).toBe('APPROVED');
      expect((await state(emp.id))?.status).toBe('ELIGIBLE');
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).body.error.code).toBe('CREDENTIAL_NOT_PENDING');
    });

    it('stores ExpiringSoon within 60 days and Expired past expiry; tracking data is validated against the template', async () => {
      const { emp } = await makeNurse(db, org.unitB.id);
      const tpl = await makeTemplate(db);
      const soon = await validCredential(emp.id, tpl.id, addDays(today(), -300), addDays(today(), 30));
      expect((await db.credential.findUniqueOrThrow({ where: { id: soon } })).status).toBe('ExpiringSoon');
      const bad = await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, trackingData: { licence_number: '', issue_date: 'nope', expiry_date: '2020-01-01', extra: 'x' } });
      expect(bad.body.error.code).toBe('TRACKING_DATA_INVALID');
      expect(bad.body.error.details).toEqual(expect.arrayContaining(['extra: not a field of this template', 'licence_number: required', 'issue_date: must be YYYY-MM-DD']));
    });

    it('suspension and revocation make the nurse INELIGIBLE immediately (L3); revoked is final', async () => {
      const unit = await db.unit.create({ data: { code: `SR${Date.now()}`, name: 'Suspend unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      await require(tpl.id, unit.id);
      const id = await validCredential(emp.id, tpl.id);
      expect((await state(emp.id))?.status).toBe('ELIGIBLE');
      expect((await hr.post(`/credentials/${id}/suspend`, { reason: 'SCFHS query' })).body.status).toBe('Suspended');
      expect((await state(emp.id))?.reasons[0]).toMatchObject({ code: 'CREDENTIAL_SUSPENDED' });
      expect((await hr.post(`/credentials/${id}/revoke`, { reason: 'Licence withdrawn' })).body.status).toBe('Revoked');
      expect((await hr.post(`/credentials/${id}/suspend`, { reason: 'again' })).body.error.code).toBe('CREDENTIAL_REVOKED');
      expect(await db.auditEntry.count({ where: { resource: 'credential', resourceId: String(id), action: { in: ['CREDENTIAL_SUSPENDED', 'CREDENTIAL_REVOKED'] }, priority: 'HIGH' } })).toBe(2);
    });

    it('nobody reviews their own credential (separation of duties)', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const tpl = await makeTemplate(db, { requiresUpload: false });
      const hrNurse = await signIn(app, (await makeUser(db, { employeeId: emp.id, roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const rec = await hrNurse.post('/credentials', { employeeId: emp.id, templateId: tpl.id, ...fields(addDays(today(), -1), addDays(today(), 100)) });
      expect((await hrNurse.post(`/credentials/${rec.body.id}/verify`)).body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
      expect((await hr.post(`/credentials/${rec.body.id}/verify`)).status).toBe(200);
    });
  });

  describe('evidence rules (§5.1.5, §5.3.2, D1–D5)', () => {
    it('rejects empty, oversized, disallowed and mismatched files; accepts PDF and PNG as new versions', async () => {
      const small = testApp(db, { UPLOAD_MAX_SIZE_BYTES: '64' });
      const hrSmall = await signIn(small, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
      const { emp } = await makeNurse(db, org.unitA.id);
      const tpl = await makeTemplate(db);
      const rec = await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, ...fields(addDays(today(), -1), addDays(today(), 100)) });
      const path = `/credentials/${rec.body.id}/documents`;
      expect((await hr.upload(path, Buffer.alloc(0), 'application/pdf')).body.error.code).toBe('UPLOAD_EMPTY');
      expect((await hrSmall.upload(path, Buffer.concat([FILES.pdf, Buffer.alloc(100)]), 'application/pdf')).status).toBe(413);
      expect((await hr.upload(path, FILES.exe, 'application/x-msdownload', 'x.exe')).body.error.code).toBe('UPLOAD_TYPE_NOT_ALLOWED');
      expect((await hr.upload(path, FILES.exe, 'application/pdf')).body.error.code).toBe('UPLOAD_TYPE_MISMATCH');
      expect((await hr.upload(path, FILES.png, 'application/pdf')).body.error.code).toBe('UPLOAD_TYPE_MISMATCH');
      const v1 = await hr.upload(path, FILES.pdf, 'application/pdf');
      const v2 = await hr.upload(path, FILES.png, 'image/png', 'scan.png');
      expect([v1.body.version, v2.body.version]).toEqual([1, 2]);
    });

    it('serves only CLEAN files, only to the owner and scoped HR; supervisors never see or download evidence', async () => {
      const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
      const tpl = await makeTemplate(db);
      const id = await validCredential(emp.id, tpl.id);
      const docs = await hr.get(`/credentials/${id}/documents`);
      const docId = docs.body.items[0].id as number;
      expect(docs.body.items[0]).toMatchObject({ isCurrentEvidence: true, reviewStatus: 'APPROVED' });
      const dl = await hr.get(`/credentials/${id}/documents/${docId}`);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/pdf');
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(await db.auditEntry.count({ where: { action: 'DOCUMENT_DOWNLOADED', resourceId: String(id) } })).toBe(1);

      const own = await signIn(app, user!.email);
      expect((await own.get(`/credentials/${id}/documents/${docId}`)).status).toBe(200);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      expect((await sup.get(`/credentials/${id}/documents`)).status).toBe(403);
      expect((await sup.get(`/credentials/${id}/documents/${docId}`)).status).toBe(403);
      // The supervisor compliance view carries no tracking data, pending values or evidence ids.
      const view = await sup.get(`/credentials/${id}`);
      expect(view.status).toBe(200);
      expect(view.body).not.toHaveProperty('trackingData');
      expect(view.body).not.toHaveProperty('pendingData');
      expect(view.body).not.toHaveProperty('latestEvidenceId');

      await db.documentVersion.update({ where: { id: docId }, data: { scanStatus: 'INFECTED' } });
      expect((await hr.get(`/credentials/${id}/documents/${docId}`)).body.error.code).toBe('DOCUMENT_NOT_CLEAN');
    });

    it('another employee cannot read or upload to someone else\'s credential', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const other = await makeNurse(db, org.unitA.id, { account: true });
      const tpl = await makeTemplate(db);
      const id = await validCredential(emp.id, tpl.id);
      const c = await signIn(app, other.user!.email);
      expect((await c.get(`/credentials/${id}`)).status).toBe(403);
      expect((await c.upload(`/credentials/${id}/documents`, FILES.pdf, 'application/pdf')).status).toBe(403);
      expect((await c.get('/credentials')).status).toBe(403);
    });
  });

  describe('grace periods (§6.1.1 acceptance criteria, L8)', () => {
    async function expiredWithGrace() {
      const unit = await db.unit.create({ data: { code: `GR${Date.now()}${Math.random().toString(36).slice(2, 5)}`, name: 'Grace unit', departmentId: org.dept.id } });
      const { emp, user } = await makeNurse(db, unit.id, { account: true });
      const tpl = await makeTemplate(db, { gracePeriodDays: 30 });
      await require(tpl.id, unit.id);
      // Verified last year, expired five days ago.
      const id = await validCredential(emp.id, tpl.id, addDays(today(), -400), addDays(today(), -5));
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
      return { emp, user: user!, tpl, id };
    }

    it('"Grace activation" + "Eligibility with grace": a staged renewal puts the nurse in ELIGIBLE_WITH_GRACE, never silently', async () => {
      const { emp, user, id } = await expiredWithGrace();
      const own = await signIn(app, user.email);
      const renewal = await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      expect(renewal.status).toBe(200);
      const s = await state(emp.id);
      expect(s?.status).toBe('ELIGIBLE_WITH_GRACE');
      expect(s?.reasons[0]).toMatchObject({ code: 'GRACE_ACTIVE', until: addDays(addDays(today(), -5), 30) });
      const cred = await db.credential.findUniqueOrThrow({ where: { id } });
      expect(cred.graceCycleId).toBeTruthy();
      expect(await db.auditEntry.count({ where: { action: 'GRACE_ACTIVATED', resourceId: String(id), priority: 'HIGH' } })).toBe(1);
      // Notified: the nurse ("Renewal Required — Grace Period Active") and scoped HR.
      const notes = await db.notification.findMany({ where: { employeeId: emp.id, type: 'ELIGIBILITY' } });
      expect(notes.map((n) => n.recipientId)).toContain(user.id);
      expect(notes.find((n) => n.recipientId === user.id)?.title).toBe('Renewal Required — Grace Period Active');
      expect(notes.length).toBeGreaterThan(1);
      // Re-evaluating the same cycle does not activate grace twice.
      await hr.post(`/eligibility/${emp.id}/refresh`);
      expect(await db.auditEntry.count({ where: { action: 'GRACE_ACTIVATED', resourceId: String(id) } })).toBe(1);
    });

    it('"Renewal approval closes grace": the new dates are promoted and grace fields cleared', async () => {
      const { emp, user, id } = await expiredWithGrace();
      const own = await signIn(app, user.email);
      await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      await own.upload(`/credentials/${id}/documents`, FILES.pdf, 'application/pdf', 'renewal.pdf');
      const ok = await hr.post(`/credentials/${id}/renewal/approve`);
      expect(ok.body).toEqual({ id, status: 'Valid' });
      const cred = await db.credential.findUniqueOrThrow({ where: { id } });
      expect(cred).toMatchObject({ graceCycleId: null, graceExpiryDate: null, pendingData: null });
      expect((await state(emp.id))?.status).toBe('ELIGIBLE');
      expect(await db.auditEntry.count({ where: { action: 'GRACE_COMPLETED', resourceId: String(id) } })).toBe(1);
    });

    it('"Renewal rejection closes grace": INELIGIBLE at once, and re-submitting cannot re-open the same window', async () => {
      const { emp, user, id } = await expiredWithGrace();
      const own = await signIn(app, user.email);
      await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      expect((await state(emp.id))?.status).toBe('ELIGIBLE_WITH_GRACE');
      expect((await hr.post(`/credentials/${id}/renewal/reject`, { reason: 'Document illegible' })).status).toBe(200);
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
      expect(await db.auditEntry.count({ where: { action: 'GRACE_CLOSED', resourceId: String(id), priority: 'HIGH' } })).toBe(1);
      await own.post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
    });

    it('"Suspension/revocation overrides grace"', async () => {
      const { emp, user, id } = await expiredWithGrace();
      await (await signIn(app, user.email)).post(`/credentials/${id}/renewal`, fields(addDays(today(), -2), addDays(today(), 700)));
      await hr.post(`/credentials/${id}/suspend`, { reason: 'Under investigation' });
      expect((await state(emp.id))?.reasons[0]).toMatchObject({ code: 'CREDENTIAL_SUSPENDED' });
    });
  });

  describe('policy transitions (§6.1.1.1 acceptance criteria, L10)', () => {
    it('"Transition mode" warns until the deadline; "Hard deadline enforcement" blocks once it has passed', async () => {
      const unit = await db.unit.create({ data: { code: `TR${Date.now()}`, name: 'Transition unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      const r = await require(tpl.id, unit.id, { policyStatus: 'TRANSITION', transitionDeadline: addDays(today(), 30) });
      const s1 = await state(emp.id);
      expect(s1?.status).toBe('ELIGIBLE_WITH_POLICY_WARNING');
      expect(s1?.reasons[0]).toMatchObject({ code: 'POLICY_TRANSITION_WARNING', until: addDays(today(), 30) });
      expect((await hr.put(`/credential-requirements/${r.body.id}`, { transitionDeadline: addDays(today(), -1) })).status).toBe(200);
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
    });
  });

  describe('emergency waivers (§6.1.2 acceptance criteria, L9)', () => {
    async function ineligibleNurse() {
      const unit = await db.unit.create({ data: { code: `WV${Date.now()}${Math.random().toString(36).slice(2, 5)}`, name: 'Waiver unit', departmentId: org.dept.id } });
      const { emp } = await makeNurse(db, unit.id);
      const tpl = await makeTemplate(db);
      await require(tpl.id, unit.id);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [unit.id] }] })).email);
      return { emp, tpl, sup, unit };
    }
    const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

    it('"Waiver grants eligibility" + "High-priority audit" with the supervisor and the clinical justification', async () => {
      const { emp, tpl, sup } = await ineligibleNurse();
      expect((await state(emp.id))?.status).toBe('INELIGIBLE');
      const w = await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'ICU short-staffed; licence renewal confirmed by phone', expiresAt: inHours(24) });
      expect(w.status).toBe(201);
      expect(w.body.eligibility).toBe('ELIGIBLE');
      const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'WAIVER_GRANTED', resourceId: String(w.body.id) } });
      expect(audit.priority).toBe('HIGH');
      expect(audit.changes).toMatchObject({ justification: 'ICU short-staffed; licence renewal confirmed by phone', templateId: tpl.id });
    });

    it('"Maximum duration": more than 72 hours, or an expiry in the past, is rejected', async () => {
      const { emp, tpl, sup } = await ineligibleNurse();
      expect((await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(72.1) })).body.error.code).toBe('WAIVER_WINDOW_EXCEEDED');
      expect((await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(-1) })).body.error.code).toBe('WAIVER_EXPIRY_IN_PAST');
      expect((await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: '   ', expiresAt: inHours(2) })).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('"Authority check": only a Supervisor or HR Admin covering the nurse; System Admin and employees get 403', async () => {
      const { emp, tpl } = await ineligibleNurse();
      const body = { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(2) };
      const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
      expect((await sa.post('/waivers', body)).status).toBe(403);
      const nurse = await signIn(app, (await makeUser(db)).email);
      expect((await nurse.post('/waivers', body)).status).toBe(403);
      const otherSup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
      expect((await otherSup.post('/waivers', body)).body.error.code).toBe('SCOPE_NOT_COVERED');
      expect((await hr.post('/waivers', body)).status).toBe(201);
    });

    it('"Automatic expiry": once the waiver has lapsed the engine is INELIGIBLE again', async () => {
      const { emp, tpl, sup } = await ineligibleNurse();
      const w = await sup.post('/waivers', { employeeId: emp.id, templateId: tpl.id, reason: 'cover', expiresAt: inHours(1) });
      await db.$executeRaw`UPDATE credential_waivers SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 second' WHERE id = ${w.body.id}`;
      const r = await sup.get(`/eligibility/${emp.id}/evaluate?date=${today()}`);
      expect(r.body.status).toBe('INELIGIBLE');
    });
  });

  describe('eligibility reads and self-service', () => {
    it('evaluates a nurse for a given day without storing it; the contract must cover that day', async () => {
      const { emp } = await makeNurse(db, org.unitA.id);
      const later = await hr.get(`/eligibility/${emp.id}/evaluate?date=${addDays(today(), 400)}`);
      expect(later.body.reasons.map((r: { code: string }) => r.code)).toContain('NO_CONTRACT_COVERAGE');
      expect((await hr.get(`/eligibility/${emp.id}/evaluate?date=not-a-date`)).body.error.code).toBe('VALIDATION_FAILED');
    });

    it('an employee submits their own credential and reads their own state; a supervisor lists only their units', async () => {
      const { emp, user } = await makeNurse(db, org.unitB.id, { account: true });
      const tpl = await makeTemplate(db);
      const own = await signIn(app, user!.email);
      expect((await own.post('/credentials/me', { templateId: tpl.id, ...fields(addDays(today(), -1), addDays(today(), 200)) })).status).toBe(201);
      expect((await own.get('/credentials/me')).body.items).toHaveLength(1);
      await hr.post(`/eligibility/${emp.id}/refresh`);
      expect((await own.get('/eligibility/me')).status).toBe(200);
      const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
      const list = await sup.get('/eligibility');
      expect(list.body.items.every((s: { employee: { unitId: number } }) => s.employee.unitId === org.unitC.id)).toBe(true);
      expect((await sup.get(`/eligibility/${emp.id}`)).status).toBe(403);
    });
  });

  describe('catalog', () => {
    it('only system-wide administrators change templates; grace is limited to 0–90 days', async () => {
      const scoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
      const body = { code: `TPL_${Date.now()}`, name: 'New template', categoryCode: 'LICENSURE' };
      expect((await scoped.post('/credential-templates', body)).body.error.code).toBe('SCOPE_NOT_COVERED');
      const made = await hr.post('/credential-templates', body);
      expect(made.status).toBe(201);
      expect((await hr.patch(`/credential-templates/${made.body.id}`, { gracePeriodDays: 91 })).body.error.code).toBe('VALIDATION_FAILED');
      expect((await hr.patch(`/credential-templates/${made.body.id}`, { gracePeriodDays: 14 })).body.gracePeriodDays).toBe(14);
      expect((await (await signIn(app, (await makeUser(db)).email)).get('/credential-templates')).status).toBe(200);
    });
  });

  describe('unauthorized access sweep (R15)', () => {
    const STAFF_ONLY: Array<[string, string]> = [
      ['GET', '/credentials'], ['POST', '/credentials'], ['POST', '/credentials/1/verify'], ['POST', '/credentials/1/suspend'],
      ['POST', '/credentials/1/revoke'], ['POST', '/credentials/1/renewal/approve'], ['POST', '/credentials/1/renewal/reject'],
      ['GET', '/credential-requirements'], ['POST', '/credential-requirements'], ['PUT', '/credential-requirements/1'],
      ['DELETE', '/credential-requirements/1'], ['POST', '/credential-requirements/bulk'], ['POST', '/credential-templates'],
      ['PATCH', '/credential-templates/1'], ['GET', '/eligibility'], ['GET', '/eligibility/1/evaluate?date=2026-01-01'],
      ['POST', '/eligibility/1/refresh'], ['GET', '/waivers'], ['POST', '/waivers'],
    ];

    it('anonymous callers get 401 everywhere; plain employees get 403 on every staff endpoint', async () => {
      const { default: request } = await import('supertest');
      const emp = await signIn(app, (await makeUser(db)).email);
      for (const [method, path] of STAFF_ONLY) {
        const anon = await request(app)[method.toLowerCase() as 'get'](`/api/v1${path}`).set('Origin', 'http://localhost:5173').send({});
        expect([method, path, anon.status]).toEqual([method, path, 401]);
        const r = method === 'GET' ? await emp.get(path) : method === 'PUT' ? await emp.put(path, {}) : method === 'DELETE' ? await emp.del(path)
          : method === 'PATCH' ? await emp.patch(path, {}) : await emp.post(path, {});
        expect([method, path, r.status]).toEqual([method, path, 403]);
      }
    });
  });

  it('leaves the audit chain intact', async () => {
    expect(await findChainBreaks(db)).toEqual([]);
  });
});
