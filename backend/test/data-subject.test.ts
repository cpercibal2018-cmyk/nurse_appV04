// Data-subject rights (spec §8.3.3, D-55): access / portability packages,
// rectification, and erasure by crypto-shredding with four eyes.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { fieldRows } from '../src/modules/credentials/fields.js';
import type { FieldDef } from '../src/modules/credentials/catalog.js';
import { reconcileVault } from '../src/jobs/vault-reconcile.js';
import { businessHealth } from '../src/modules/audit/business-health.js';
import { reapplyErasure } from '../src/cli/pdpl-reerase.js';
import { fieldCryptoFromEnv } from '../src/lib/field-crypto.js';
import { createProtection } from '../src/modules/pdpl/protection.js';
import { createLocalDiskAdapter, createVault, documentKey } from '../src/lib/vault.js';
import { FILES, makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const objectPath = (root: string, key: string) => path.join(root, key.slice(0, 2), key);
const exists = (p: string) => readFile(p).then(() => true, () => false);

describeDb('data-subject requests (D-55)', () => {
  let db: Db;
  let app: Express;
  let root: string;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Awaited<ReturnType<typeof signIn>>;
  let saA: Awaited<ReturnType<typeof signIn>>;
  let saB: Awaited<ReturnType<typeof signIn>>;
  let tplId: number;

  beforeAll(async () => {
    db = openDb();
    root = await mkdtemp(path.join(os.tmpdir(), 'dsr-'));
    app = testApp(db, { STORAGE_DIR: root });
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    saA = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    saB = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    await db.credentialCategory.upsert({ where: { code: 'IDENTITY' }, update: {}, create: { code: 'IDENTITY', name: 'Identity' } });
    const t = await db.credentialTemplate.create({ data: { code: uniq('IQ').toUpperCase(), name: 'Test Iqama', categoryCode: 'IDENTITY', hasExpiry: true, requiresUpload: false } });
    const defs: FieldDef[] = [
      { key: 'iqama_number', label: 'Iqama number', type: 'text', required: true, displayOrder: 1, pdplCategory: 'IQAMA' },
      { key: 'expiry_date', label: 'Expiry', type: 'date', required: true, displayOrder: 2, isExpiryDate: true },
    ];
    await db.credentialTemplateField.createMany({ data: fieldRows(t.id, defs) });
    tplId = t.id;
  });
  afterAll(async () => { await db.$disconnect(); await rm(root, { recursive: true, force: true }); });

  const fresh = () => String(2_000_000_000 + Math.floor(Math.random() * 999_999_999));
  const nurseWithIqama = async () => {
    const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
    const iqama = fresh();
    const cred = await hr.post('/credentials', { employeeId: emp.id, templateId: tplId, trackingData: { iqama_number: iqama, expiry_date: '2029-01-01' } });
    expect(cred.status).toBe(201);
    return { emp, user: user!, iqama, credentialId: cred.body.id as number, own: await signIn(app, user!.email) };
  };

  it('an employee asks for their data; HR reviews and approves; the package holds their data, opened, and nobody else\'s', async () => {
    const { emp, user, iqama, own } = await nurseWithIqama();
    const other = await nurseWithIqama();
    const created = await own.post('/pdpl/requests/me', { type: 'ACCESS' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ type: 'ACCESS', status: 'RECEIVED', exportAvailable: false, overdue: false });
    expect(new Date(created.body.dueAt).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await own.post('/pdpl/requests/me', { type: 'ACCESS' })).body.error.code).toBe('REQUEST_ALREADY_OPEN');
    expect((await own.get('/pdpl/requests/me')).body.items.map((r: { id: number }) => r.id)).toEqual([created.body.id]);
    // HR in scope hears about it.
    const hrUser = await db.user.findFirstOrThrow({ where: { email: (await hr.get('/auth/me')).body.user.email } });
    expect(await db.notification.count({ where: { recipientId: hrUser.id, eventKey: `dsr:${created.body.id}:received` } })).toBe(1);

    const id = created.body.id;
    expect((await own.get(`/pdpl/requests/me/${id}/export`)).body.error.code).toBe('EXPORT_NOT_AVAILABLE');
    expect((await hr.post(`/pdpl/requests/${id}/review`)).body.status).toBe('IN_REVIEW');
    const approved = await hr.post(`/pdpl/requests/${id}/approve`, {});
    expect(approved.body).toMatchObject({ status: 'COMPLETED', exportAvailable: true });

    const pkg = await own.get(`/pdpl/requests/me/${id}/export`);
    expect(pkg.status).toBe(200);
    expect(pkg.headers['content-disposition']).toContain(`attachment; filename*=UTF-8''personal-data-${emp.jobNumber}-`);
    const data = JSON.parse(pkg.text);
    expect(data).toMatchObject({ format: 'aigh-nurseapp/personal-data', version: 1, employee: { jobNumber: emp.jobNumber }, account: { email: user.email } });
    expect(data.credentials[0].details.iqama_number).toBe(iqama);
    expect(data.contracts).toHaveLength(1);
    expect(data.processingPurposes.map((p: { dataCategory: string }) => p.dataCategory)).toContain('IQAMA');
    expect(pkg.text).not.toContain(other.iqama);
    expect(pkg.text).not.toContain(other.emp.jobNumber);
    // HR can download it for the employee too; each download is audited HIGH.
    expect((await hr.get(`/pdpl/requests/${id}/export`)).status).toBe(200);
    const audits = await db.auditEntry.findMany({ where: { action: 'PERSONAL_DATA_EXPORTED', resourceId: String(id) } });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.priority === 'HIGH')).toBe(true);
    expect(JSON.stringify(audits.map((a) => a.changes))).not.toContain(iqama);
    // Someone else's request is not theirs to download; the employee hears the outcome.
    expect((await other.own.get(`/pdpl/requests/me/${id}/export`)).status).toBe(404);
    expect(await db.notification.count({ where: { recipientId: user.id, eventKey: `dsr:${id}:COMPLETED` } })).toBe(1);
  });

  it('scope, roles and separation of duties', async () => {
    const { emp, own } = await nurseWithIqama();
    const id = (await own.post('/pdpl/requests/me', { type: 'PORTABILITY' })).body.id;
    const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    expect((await sup.get('/pdpl/requests')).status).toBe(403);
    expect((await own.get('/pdpl/requests')).status).toBe(403);
    const otherHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
    expect((await otherHr.get('/pdpl/requests')).body.items.map((r: { id: number }) => r.id)).not.toContain(id);
    expect((await otherHr.post(`/pdpl/requests/${id}/approve`, {})).body.error.code).toBe('SCOPE_NOT_COVERED');
    expect((await otherHr.get(`/pdpl/requests/${id}/export`)).body.error.code).toBe('SCOPE_NOT_COVERED');
    // HR who is the employee cannot decide their own request.
    const selfHr = await signIn(app, (await makeUser(db, { employeeId: null, roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    await db.user.updateMany({ where: { employeeId: emp.id }, data: { employeeId: null } });
    const selfHrUser = await db.user.findFirstOrThrow({ where: { email: (await selfHr.get('/auth/me')).body.user.email } });
    await db.user.update({ where: { id: selfHrUser.id }, data: { employeeId: emp.id } });
    expect((await selfHr.post(`/pdpl/requests/${id}/approve`, {})).body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
    // Filters.
    const open = await hr.get('/pdpl/requests?open=true&type=PORTABILITY');
    expect(open.body.items.every((r: { status: string; type: string }) => r.type === 'PORTABILITY' && ['RECEIVED', 'IN_REVIEW', 'APPROVED'].includes(r.status))).toBe(true);
  });

  it('rectification: details required; approved, then completed with a note; declines need a reason', async () => {
    const { own } = await nurseWithIqama();
    expect((await own.post('/pdpl/requests/me', { type: 'RECTIFICATION' })).status).toBe(400);
    const id = (await own.post('/pdpl/requests/me', { type: 'RECTIFICATION', details: 'My middle name is spelled Abdul-Rahman' })).body.id;
    expect((await hr.post(`/pdpl/requests/${id}/complete`, { note: 'Corrected the middle name' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await hr.post(`/pdpl/requests/${id}/approve`, {})).body.status).toBe('APPROVED');
    expect((await hr.post(`/pdpl/requests/${id}/complete`, { note: 'short' })).status).toBe(400);
    const done = await hr.post(`/pdpl/requests/${id}/complete`, { note: 'Corrected the middle name in the employee record' });
    expect(done.body).toMatchObject({ status: 'COMPLETED', decisionNote: 'Corrected the middle name in the employee record', exportAvailable: false });
    // A closed request is final, even in the database.
    await expect(db.dataSubjectRequest.update({ where: { id }, data: { status: 'IN_REVIEW' } })).rejects.toThrow(/closed data-subject request/);
    await expect(db.dataSubjectRequest.delete({ where: { id } })).rejects.toThrow(/never deleted/);

    const id2 = (await own.post('/pdpl/requests/me', { type: 'ACCESS' })).body.id;
    expect((await hr.post(`/pdpl/requests/${id2}/reject`, {})).status).toBe(400);
    const rejected = await hr.post(`/pdpl/requests/${id2}/reject`, { note: 'Duplicate of the request answered last week' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decisionNote: 'Duplicate of the request answered last week' });
    expect((await hr.post(`/pdpl/requests/${id2}/approve`, {})).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('erasure: a second System Admin approves; the key is destroyed, the index and identity scans go, and the evidence is kept', async () => {
    const { emp, iqama, credentialId, own } = await nurseWithIqama();
    const up = await hr.upload(`/credentials/${credentialId}/documents`, FILES.pdf, 'application/pdf', 'iqama.pdf');
    expect(up.status).toBe(201);
    const doc = await db.documentVersion.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(await exists(objectPath(root, doc.storageKey))).toBe(true);

    // Logged by a System Admin on the employee's behalf.
    const logged = await saA.post('/pdpl/requests', { employeeId: emp.id, type: 'ERASURE', details: 'Received by e-mail from the employee' });
    expect(logged.status).toBe(201);
    const id = logged.body.id;
    const saBUser = await db.user.findFirstOrThrow({ where: { email: (await saB.get('/auth/me')).body.user.email } });
    const hrUser = await db.user.findFirstOrThrow({ where: { email: (await hr.get('/auth/me')).body.user.email } });
    expect(await db.notification.count({ where: { recipientId: saBUser.id, eventKey: `dsr:${id}:received`, priority: 'HIGH' } })).toBe(1);
    expect(await db.notification.count({ where: { recipientId: hrUser.id, eventKey: `dsr:${id}:received` } })).toBe(0); // erasure: System Admins only

    const confirm = { note: 'Employee left the hospital; lawful basis ended', confirmJobNumber: emp.jobNumber };
    expect((await hr.post(`/pdpl/requests/${id}/approve`, {})).body.error.code).toBe('ERASURE_NEEDS_SYSTEM_ADMIN');
    expect((await hr.post(`/pdpl/requests/${id}/erase`, confirm)).status).toBe(403);
    expect((await saA.post(`/pdpl/requests/${id}/erase`, confirm)).body.error.code).toBe('FOUR_EYES_REQUIRED');
    expect((await saB.post(`/pdpl/requests/${id}/erase`, { ...confirm, confirmJobNumber: 'WRONG' })).body.error.code).toBe('CONFIRMATION_MISMATCH');
    const before = Date.now();
    const erased = await saB.post(`/pdpl/requests/${id}/erase`, confirm);
    expect(erased.status).toBe(200);
    expect(erased.body).toMatchObject({ status: 'COMPLETED', erasure: { documentsErased: 1 } });
    const { keyDestroyedAt, backupsExpireAt } = erased.body.erasure;
    expect(new Date(keyDestroyedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(backupsExpireAt).getTime() - new Date(keyDestroyedAt).getTime()).toBe(31 * 86_400_000); // 30-day backups + the next nightly run

    const key = await db.employeeKey.findUniqueOrThrow({ where: { employeeId: emp.id } });
    expect(key).toMatchObject({ wrappedKey: null });
    expect(key.destroyedAt).not.toBeNull();
    expect(await db.pdplIdentifierIndex.count({ where: { credentialId } })).toBe(0);
    expect((await hr.get(`/credentials?identifier=${iqama}`)).body.items).toEqual([]);
    const cred = await hr.get(`/credentials/${credentialId}`);
    expect(cred.body).toMatchObject({ personalDataErased: true, trackingData: { iqama_number: null } });
    // The scan: row kept and marked, file gone, never served.
    expect((await db.documentVersion.findUniqueOrThrow({ where: { id: doc.id } })).erasedAt).not.toBeNull();
    expect(await exists(objectPath(root, doc.storageKey))).toBe(false);
    expect((await hr.get(`/credentials/${credentialId}/documents/${doc.id}`)).status).toBe(410);
    expect((await hr.post(`/credentials/${credentialId}/documents/${doc.id}/link`, {})).status).toBe(410);
    expect((await hr.get(`/credentials/${credentialId}/documents`)).body.items[0].erasedAt).not.toBeNull();
    // New sensitive values are refused; the employee sees their record as erased.
    expect((await hr.post('/credentials', { employeeId: emp.id, templateId: tplId, trackingData: { iqama_number: fresh(), expiry_date: '2030-01-01' } })).body.error.code).toBe('PERSONAL_DATA_ERASED');
    expect((await own.get('/pdpl/requests/me')).body.items[0]).toMatchObject({ status: 'COMPLETED', erasure: { documentsErased: 1 } });
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'PERSONAL_DATA_ERASED', resourceId: String(id) } });
    expect(audit.priority).toBe('HIGH');
    expect(JSON.stringify(audit.changes)).not.toContain(iqama);
    // The key's record stays; a second erasure has nothing left to destroy.
    await expect(db.employeeKey.delete({ where: { employeeId: emp.id } })).rejects.toThrow(/cannot be deleted/);
    const again = (await own.post('/pdpl/requests/me', { type: 'ERASURE' })).body.id;
    expect((await saB.post(`/pdpl/requests/${again}/erase`, confirm)).body.error.code).toBe('ALREADY_ERASED');
    // An access package after erasure says so instead of showing the value.
    const access = (await own.post('/pdpl/requests/me', { type: 'ACCESS' })).body.id;
    await hr.post(`/pdpl/requests/${access}/approve`, {});
    const pkg = JSON.parse((await own.get(`/pdpl/requests/me/${access}/export`)).text);
    expect(pkg.credentials[0]).toMatchObject({ personalDataErased: true, details: { iqama_number: null }, documents: [{ fileName: 'iqama.pdf', erased: true }] });
  });

  it('erasure covers values stored before protection, and an employee with no key yet', async () => {
    const { emp } = await makeNurse(db, org.unitA.id, { account: true });
    const legacy = fresh();
    const c = await db.credential.create({ data: { employeeId: emp.id, templateId: tplId, trackingData: { iqama_number: legacy, expiry_date: '2029-01-01' } } });
    expect(await db.employeeKey.count({ where: { employeeId: emp.id } })).toBe(0);
    const id = (await hr.post('/pdpl/requests', { employeeId: emp.id, type: 'ERASURE' })).body.id;
    expect((await saA.post(`/pdpl/requests/${id}/erase`, { note: 'Former employee asked for erasure', confirmJobNumber: emp.jobNumber })).status).toBe(200);
    const row = await db.credential.findUniqueOrThrow({ where: { id: c.id } });
    expect(JSON.stringify(row.trackingData)).not.toContain(legacy);
    expect((row.trackingData as Record<string, string>).iqama_number).toMatch(/^pdpl:v1:/);
    expect((await db.employeeKey.findUniqueOrThrow({ where: { employeeId: emp.id } })).wrappedKey).toBeNull();
  });

  it('the database enforces four eyes and the erasure evidence', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const requester = await makeUser(db);
    const r = await db.dataSubjectRequest.create({ data: { employeeId: emp.id, requestType: 'ERASURE', requestedById: requester.id } });
    await expect(db.dataSubjectRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', decidedById: requester.id, decidedAt: new Date(), completedAt: new Date(), keyDestroyedAt: new Date(), backupsExpireAt: new Date(), documentsErased: 0 } }))
      .rejects.toThrow(/chk_dsr_erasure_four_eyes/);
    const other = await makeUser(db);
    await expect(db.dataSubjectRequest.update({ where: { id: r.id }, data: { status: 'COMPLETED', decidedById: other.id, decidedAt: new Date(), completedAt: new Date() } }))
      .rejects.toThrow(/chk_dsr_erasure_evidence/);
  });

  it('after a restore, pdpl:reerase applies an erasure again', async () => {
    const vault = createVault(createLocalDiskAdapter(root), documentKey(testEnv()));
    const protection = createProtection(fieldCryptoFromEnv(testEnv()));
    const { emp, iqama, credentialId } = await nurseWithIqama(); // as restored: key and scan present
    const up = await hr.upload(`/credentials/${credentialId}/documents`, FILES.pdf, 'application/pdf', 'iqama.pdf');
    const doc = await db.documentVersion.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(await reapplyErasure(db, protection, vault, emp.id)).toEqual({ employeeId: emp.id, status: 'ERASED', documentsErased: 1 });
    expect((await db.employeeKey.findUniqueOrThrow({ where: { employeeId: emp.id } })).wrappedKey).toBeNull();
    expect((await hr.get(`/credentials?identifier=${iqama}`)).body.items).toEqual([]);
    expect(await exists(objectPath(root, doc.storageKey))).toBe(false);
    expect(await db.auditEntry.count({ where: { action: 'PERSONAL_DATA_ERASURE_REAPPLIED', resourceId: String(emp.id) } })).toBe(1);
    expect((await reapplyErasure(db, protection, vault, emp.id)).status).toBe('ALREADY_ERASED');
  });

  it('System health reports requests past the 30-day deadline', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const requester = await makeUser(db);
    await db.dataSubjectRequest.create({ data: { employeeId: emp.id, requestType: 'ACCESS', requestedById: requester.id, requestedAt: new Date(Date.now() - 31 * 86_400_000) } });
    const health = await businessHealth(db);
    expect(health.pdpl.overdueRequests).toBeGreaterThanOrEqual(1);
    expect(health.issues.map((i: { code: string }) => i.code)).toContain('PDPL_REQUESTS_OVERDUE');
    expect((await hr.get('/pdpl/requests?open=true')).body.items.some((r: { employee: { id: number }; overdue: boolean }) => r.employee.id === emp.id && r.overdue)).toBe(true);
  });

  it('the daily vault check removes an erased file left behind, without calling it missing', async () => {
    const vault = createVault(createLocalDiskAdapter(root), documentKey(testEnv()));
    const { credentialId } = await nurseWithIqama();
    const up = await hr.upload(`/credentials/${credentialId}/documents`, FILES.pdf, 'application/pdf', 'scan.pdf');
    const doc = await db.documentVersion.update({ where: { id: up.body.id }, data: { erasedAt: new Date() } }); // as if the removal had failed
    expect(await exists(objectPath(root, doc.storageKey))).toBe(true);
    const out = await reconcileVault(db, vault);
    expect(out.erasedRemoved).toBeGreaterThanOrEqual(1);
    expect(await exists(objectPath(root, doc.storageKey))).toBe(false);
    expect(out.missingDocumentIds).not.toContain(doc.id);
    expect(out.failedDocumentIds).not.toContain(doc.id);
  });
});
