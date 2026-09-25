// PDPL field protection (spec §8.3.1–8.3.4, D-54): sensitive identifiers are
// encrypted per employee, found through a blind index, gated by the
// processing register, and never logged.

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { createFieldCrypto, redactIdentifiers } from '../src/lib/field-crypto.js';
import { loadEnv } from '../src/config/env.js';
import { protectExisting } from '../src/cli/pdpl-protect.js';
import { createProtection } from '../src/modules/pdpl/protection.js';
import { fieldCryptoFromEnv } from '../src/lib/field-crypto.js';
import { businessHealth } from '../src/modules/audit/business-health.js';
import { fieldRows, presentTemplate, WITH_FIELDS } from '../src/modules/credentials/fields.js';
import type { FieldDef } from '../src/modules/credentials/catalog.js';
import { makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

describe('field crypto library', () => {
  const fc = createFieldCrypto(crypto.randomBytes(32), crypto.randomBytes(32));
  const dek = fc.unwrapKey(7, fc.newWrappedKey(7));

  it('seals per employee and field; the ciphertext never contains the value', () => {
    const sealed = fc.seal(dek, 7, 'iqama_number', '2123456789');
    expect(sealed).toMatch(/^pdpl:v1:[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('2123456789');
    expect(fc.seal(dek, 7, 'iqama_number', '2123456789')).not.toBe(sealed); // random IV
    expect(fc.open(dek, 7, 'iqama_number', sealed)).toBe('2123456789');
    expect(() => fc.open(dek, 8, 'iqama_number', sealed)).toThrow(); // bound to the employee
    expect(() => fc.open(dek, 7, 'passport_number', sealed)).toThrow(); // and to the field
    expect(() => fc.unwrapKey(8, fc.newWrappedKey(7))).toThrow();
  });

  it('blind index: deterministic, normalised, per category, keyed', () => {
    expect(fc.blindIndex('IQAMA', '2123-456 789')).toBe(fc.blindIndex('IQAMA', '2123456789'));
    expect(fc.blindIndex('PASSPORT', 'k1234567')).toBe(fc.blindIndex('PASSPORT', 'K1234567'));
    expect(fc.blindIndex('IQAMA', '2123456789')).not.toBe(fc.blindIndex('PASSPORT', '2123456789'));
    expect(createFieldCrypto(crypto.randomBytes(32), crypto.randomBytes(32)).blindIndex('IQAMA', '2123456789')).not.toBe(fc.blindIndex('IQAMA', '2123456789'));
    expect(fc.blindIndex('IQAMA', '2123456789')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('log redaction masks national ID / Iqama shaped numbers only', () => {
    expect(redactIdentifiers('{"q":"1023456789","n":"2123456789","x":12345,"phone":"+966512345678"}'))
      .toBe('{"q":"[REDACTED-ID]","n":"[REDACTED-ID]","x":12345,"phone":"+966512345678"}');
    expect(redactIdentifiers('id 31234567890 and 3123456789')).toBe('id 31234567890 and 3123456789');
  });

  it('production requires both PDPL keys, each different from every other key', () => {
    const k = (n: number) => Buffer.alloc(32, n).toString('base64');
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'x'.repeat(40), MFA_ENCRYPTION_KEY: k(1), DOCUMENT_ENCRYPTION_KEY: k(2) };
    expect(() => loadEnv(base)).toThrow(/PDPL_FIELD_ENCRYPTION_KEY: required in production/);
    expect(() => loadEnv({ ...base, PDPL_FIELD_ENCRYPTION_KEY: k(3) })).toThrow(/PDPL_BLIND_INDEX_PEPPER: required in production/);
    expect(() => loadEnv({ ...base, PDPL_FIELD_ENCRYPTION_KEY: k(1), PDPL_BLIND_INDEX_PEPPER: k(4) })).toThrow(/PDPL_FIELD_ENCRYPTION_KEY: must differ from MFA_ENCRYPTION_KEY/);
    expect(loadEnv({ ...base, PDPL_FIELD_ENCRYPTION_KEY: k(3), PDPL_BLIND_INDEX_PEPPER: k(4) }).PDPL_BLIND_INDEX_PEPPER).toHaveLength(44);
  });
});

describeDb('sensitive identifiers in credentials (D-54)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Awaited<ReturnType<typeof signIn>>;
  let tplId: number;

  const iqamaTemplate = async (extra: Partial<FieldDef> = {}) => {
    await db.credentialCategory.upsert({ where: { code: 'IDENTITY' }, update: {}, create: { code: 'IDENTITY', name: 'Identity' } });
    const t = await db.credentialTemplate.create({ data: { code: uniq('IQ').toUpperCase(), name: 'Test Iqama', categoryCode: 'IDENTITY', hasExpiry: true, requiresUpload: false } });
    const defs: FieldDef[] = [
      { key: 'iqama_number', label: 'Iqama number', type: 'text', required: true, displayOrder: 1, pdplCategory: 'IQAMA', ...extra },
      { key: 'sponsor', label: 'Sponsor', type: 'text', required: false, displayOrder: 2 },
      { key: 'expiry_date', label: 'Expiry', type: 'date', required: true, displayOrder: 3, isExpiryDate: true },
    ];
    await db.credentialTemplateField.createMany({ data: fieldRows(t.id, defs) });
    return t.id;
  };

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    tplId = await iqamaTemplate();
  });
  afterAll(async () => { await db.$disconnect(); });

  const record = (employeeId: number, iqama: string) => hr.post('/credentials', { employeeId, templateId: tplId, trackingData: { iqama_number: iqama, sponsor: 'AIGH', expiry_date: '2028-01-01' } });
  const fresh = () => String(2_000_000_000 + Math.floor(Math.random() * 999_999_999));

  it('is stored sealed with the employee\'s own key, shown in clear to HR and the employee, never to the supervisor', async () => {
    const { emp, user } = await makeNurse(db, org.unitA.id, { account: true });
    const iqama = fresh();
    const res = await record(emp.id, iqama);
    expect(res.status).toBe(201);
    const row = await db.credential.findUniqueOrThrow({ where: { id: res.body.id } });
    const stored = row.trackingData as Record<string, string>;
    expect(stored.iqama_number).toMatch(/^pdpl:v1:/);
    expect(JSON.stringify(stored)).not.toContain(iqama);
    expect(stored.sponsor).toBe('AIGH'); // ordinary fields stay as they are
    const key = await db.employeeKey.findUniqueOrThrow({ where: { employeeId: emp.id } });
    expect(key.wrappedKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key.destroyedAt).toBeNull();

    expect((await hr.get(`/credentials/${res.body.id}`)).body.trackingData.iqama_number).toBe(iqama);
    expect((await hr.get(`/credentials?employeeId=${emp.id}`)).body.items[0].trackingData.iqama_number).toBe(iqama);
    const own = await signIn(app, user!.email);
    expect((await own.get('/credentials/me')).body.items[0].trackingData.iqama_number).toBe(iqama);
    const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    expect((await sup.get(`/credentials/${res.body.id}`)).body.trackingData).toBeUndefined();
    // Nothing in the audit trail carries the value.
    const audit = await db.auditEntry.findMany({ where: { resource: 'credential', resourceId: String(res.body.id) } });
    expect(JSON.stringify(audit.map((a) => a.changes))).not.toContain(iqama);
  });

  it('HR finds a credential by the identifier; the search is audited without the value; supervisors cannot search', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const iqama = fresh();
    const id = (await record(emp.id, iqama)).body.id;
    const spaced = `${iqama.slice(0, 4)}-${iqama.slice(4, 7)} ${iqama.slice(7)}`;
    const found = await hr.get(`/credentials?identifier=${encodeURIComponent(spaced)}`);
    expect(found.body.items.map((c: { id: number }) => c.id)).toEqual([id]);
    expect((await hr.get(`/credentials?identifier=${fresh()}`)).body.items).toEqual([]);
    const search = await db.auditEntry.findFirstOrThrow({ where: { action: 'IDENTIFIER_SEARCHED' }, orderBy: { id: 'desc' } });
    expect(JSON.stringify(search.changes)).not.toContain(iqama.slice(4));
    const index = await db.pdplIdentifierIndex.findMany({ where: { credentialId: id } });
    expect(index).toHaveLength(1);
    expect(index[0]!.digest).not.toContain(iqama);
    const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    expect((await sup.get(`/credentials?identifier=${iqama}`)).status).toBe(403);
    const otherHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
    expect((await otherHr.get(`/credentials?identifier=${iqama}`)).body.items).toEqual([]); // out of scope
  });

  it('a renewal is staged sealed; approval moves the searchable identifier to the new value', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const oldIqama = fresh();
    const id = (await record(emp.id, oldIqama)).body.id;
    await hr.post(`/credentials/${id}/verify`);
    const newIqama = fresh();
    expect((await hr.post(`/credentials/${id}/renewal`, { trackingData: { iqama_number: newIqama, sponsor: 'AIGH', expiry_date: '2030-01-01' } })).status).toBe(200);
    const row = await db.credential.findUniqueOrThrow({ where: { id } });
    expect(JSON.stringify(row.pendingData)).not.toContain(newIqama);
    expect((await hr.get(`/credentials/${id}`)).body.pendingData.trackingData.iqama_number).toBe(newIqama);
    expect((await hr.post(`/credentials/${id}/renewal/approve`, {})).status).toBe(200);
    expect((await hr.get(`/credentials?identifier=${newIqama}`)).body.items.map((c: { id: number }) => c.id)).toEqual([id]);
    expect((await hr.get(`/credentials?identifier=${oldIqama}`)).body.items).toEqual([]);
    expect((await hr.get(`/credentials/${id}`)).body.trackingData.iqama_number).toBe(newIqama);
  });

  it('the processing register gates new values; HR reads it, only System Admins change it', async () => {
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const list = await hr.get('/pdpl/register');
    expect(list.status).toBe(200);
    const iqamaRow = list.body.items.find((r: { dataCategory: string; isActive: boolean }) => r.dataCategory === 'IQAMA' && r.isActive);
    expect(iqamaRow).toMatchObject({ lawfulBasis: 'LEGAL_OBLIGATION' });
    expect((await hr.patch(`/pdpl/register/${iqamaRow.id}`, { isActive: false, reason: 'testing the register gate' })).status).toBe(403);
    try {
      expect((await sa.patch(`/pdpl/register/${iqamaRow.id}`, { isActive: false, reason: 'testing the register gate' })).status).toBe(200);
      const { emp } = await makeNurse(db, org.unitA.id);
      const refused = await record(emp.id, fresh());
      expect([refused.status, refused.body.error.code]).toEqual([409, 'PROCESSING_NOT_REGISTERED']);
      expect(await db.credential.count({ where: { employeeId: emp.id } })).toBe(0);
    } finally {
      await sa.patch(`/pdpl/register/${iqamaRow.id}`, { isActive: true, reason: 'restoring after the test' });
    }
    expect(await db.auditEntry.count({ where: { action: 'PROCESSING_REGISTER_CHANGED', resourceId: String(iqamaRow.id), priority: 'HIGH' } })).toBeGreaterThanOrEqual(2);
    expect((await sa.post('/pdpl/register', { dataCategory: 'IQAMA', lawfulBasis: 'LEGAL_OBLIGATION', purpose: 'duplicate basis for the same category', retentionRule: 'Employment period', reason: 'trying a duplicate' })).status).toBe(409);
  });

  it('an erased employee key leaves the values unreadable and refuses new ones; it cannot be restored', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const id = (await record(emp.id, fresh())).body.id;
    const before = await db.employeeKey.findUniqueOrThrow({ where: { employeeId: emp.id } });
    await db.employeeKey.update({ where: { employeeId: emp.id }, data: { wrappedKey: null, destroyedAt: new Date() } });
    const view = (await hr.get(`/credentials/${id}`)).body;
    expect(view.trackingData.iqama_number).toBeNull();
    expect(view.trackingData.sponsor).toBe('AIGH');
    expect(view.personalDataErased).toBe(true);
    expect((await record(emp.id, fresh())).body.error.code).toBe('PERSONAL_DATA_ERASED');
    await expect(db.employeeKey.update({ where: { employeeId: emp.id }, data: { wrappedKey: before.wrappedKey, destroyedAt: null } })).rejects.toThrow(/cannot be restored/);
  });

  it('field definitions: sensitive only on text fields, each category once', async () => {
    const cat = await db.credentialCategory.findFirstOrThrow();
    const bad = (fieldDefs: object[]) => hr.post('/credential-templates', { code: uniq('BAD').toUpperCase(), name: 'Bad', categoryCode: cat.code, fieldDefs, reason: 'testing field validation rules' });
    expect((await bad([{ key: 'a', label: 'A', type: 'date', required: false, displayOrder: 1, pdplCategory: 'IQAMA' }])).status).toBe(400);
    expect((await bad([
      { key: 'a', label: 'A', type: 'text', required: false, displayOrder: 1, pdplCategory: 'IQAMA' },
      { key: 'b', label: 'B', type: 'text', required: false, displayOrder: 2, pdplCategory: 'IQAMA' },
    ])).status).toBe(400);
    const baseline = presentTemplate(await db.credentialTemplate.findFirstOrThrow({ where: { id: tplId }, include: WITH_FIELDS }));
    expect(baseline.fieldDefs[0]).toMatchObject({ key: 'iqama_number', pdplCategory: 'IQAMA' });
  });

  it('pdpl:protect seals values stored before, rebuilds the index, and health reports what is left', async () => {
    const { emp } = await makeNurse(db, org.unitA.id);
    const iqama = fresh();
    // As stored before D-54: plaintext in the JSON, no index.
    const c = await db.credential.create({ data: { employeeId: emp.id, templateId: tplId, status: 'PendingVerification', trackingData: { iqama_number: iqama, sponsor: 'X', expiry_date: '2028-01-01' } } });
    expect((await businessHealth(db)).issues.map((i) => i.code)).toContain('PDPL_PLAINTEXT');
    const protection = createProtection(fieldCryptoFromEnv(testEnv()));
    const out = await protectExisting(db, protection);
    expect(out.sealed).toBeGreaterThanOrEqual(1);
    const row = await db.credential.findUniqueOrThrow({ where: { id: c.id } });
    expect(JSON.stringify(row.trackingData)).not.toContain(iqama);
    expect((await hr.get(`/credentials?identifier=${iqama}`)).body.items.map((x: { id: number }) => x.id)).toEqual([c.id]);
    expect((await hr.get(`/credentials/${c.id}`)).body.trackingData.iqama_number).toBe(iqama);
    const again = await protectExisting(db, protection);
    expect(again.sealed).toBe(0);
    expect((await businessHealth(db)).pdpl.unprotectedValues).toBe(0);
  });
});

describeDb('DPO sign-off of the processing register (B-18, D-56)', () => {
  let db: Db;
  let app: Express;
  beforeAll(async () => { db = openDb(); app = testApp(db); });
  afterAll(async () => { await db.$disconnect(); });

  it('records who signed off and the register as reviewed; a change or a year makes it due again', async () => {
    const dpo = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'SYSTEM' }] })).email);
    expect((await sup.post('/pdpl/register/sign-offs', { title: 'DPO', confirm: true })).status).toBe(403);
    expect((await dpo.post('/pdpl/register/sign-offs', { title: 'Data Protection Officer' })).status).toBe(400); // must confirm
    const signed = await dpo.post('/pdpl/register/sign-offs', { title: 'Data Protection Officer', note: 'Annual review with Legal', confirm: true });
    expect(signed.status).toBe(201);
    const reg = (await dpo.get('/pdpl/register')).body;
    expect(reg.signOff).toMatchObject({ last: { id: signed.body.id, title: 'Data Protection Officer', note: 'Annual review with Legal' }, changedSince: false, due: false });
    const history = (await dpo.get('/pdpl/register/sign-offs')).body.items;
    expect(history[0].register.map((e: { dataCategory: string }) => e.dataCategory)).toEqual(expect.arrayContaining(['IQAMA', 'PASSPORT', 'SCFHS_REG', 'IDENTITY_SCAN']));
    expect(await db.auditEntry.count({ where: { action: 'PROCESSING_REGISTER_SIGNED_OFF', resourceId: String(signed.body.id), priority: 'HIGH' } })).toBe(1);
    // A year later it is due; so is it after any change.
    expect((await businessHealth(db, new Date(Date.now() + 366 * 86_400_000))).issues.map((i) => i.code)).toContain('PDPL_REGISTER_SIGN_OFF_DUE');
    const entry = reg.items.find((e: { dataCategory: string }) => e.dataCategory === 'PASSPORT');
    await sa.patch(`/pdpl/register/${entry.id}`, { retentionRule: `${entry.retentionRule} (reviewed)`, reason: 'Clarify retention wording' });
    expect((await dpo.get('/pdpl/register')).body.signOff).toMatchObject({ changedSince: true, due: true });
    await sa.patch(`/pdpl/register/${entry.id}`, { retentionRule: entry.retentionRule, reason: 'Restore the retention wording' });
    // Sign-offs are never changed or deleted.
    await expect(db.processingRegisterSignOff.delete({ where: { id: signed.body.id } })).rejects.toThrow(/cannot be changed or deleted/);
  });
});
