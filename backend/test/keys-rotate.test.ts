// Key rotation (B-18): a previous key beside the new one keeps everything
// readable; `keys:rotate` moves it; afterwards the old key is not needed.

import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/prisma.js';
import { loadEnv } from '../src/config/env.js';
import { rotateKeys } from '../src/cli/keys-rotate.js';
import { createFieldCrypto, fieldCryptoFromEnv } from '../src/lib/field-crypto.js';
import { keyId, previousKey } from '../src/lib/keyring.js';
import { createSecretBox, mfaKey } from '../src/lib/secret-box.js';
import { createLocalDiskAdapter, createVault, documentKey, VaultIntegrityError } from '../src/lib/vault.js';
import { businessHealth } from '../src/modules/audit/business-health.js';
import { fieldRows } from '../src/modules/credentials/fields.js';
import type { FieldDef } from '../src/modules/credentials/catalog.js';
import { createProtection } from '../src/modules/pdpl/protection.js';
import { FILES, makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const k = () => crypto.randomBytes(32);
const b64 = (b: Buffer) => b.toString('base64');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('rotation-aware crypto', () => {
  it('secret box: the previous key still opens; isOld tells which', () => {
    const [oldKey, newKey] = [k(), k()];
    const sealedOld = createSecretBox(oldKey).seal('JBSWY3DPEHPK3PXP');
    const box = createSecretBox(newKey, oldKey);
    expect(box.open(sealedOld)).toBe('JBSWY3DPEHPK3PXP');
    expect(box.isOld(sealedOld)).toBe(true);
    expect(box.isOld(box.seal('x'))).toBe(false);
    expect(() => createSecretBox(newKey).open(sealedOld)).toThrow();
  });

  it('field crypto: employee keys unwrap under either master key; re-wrapping keeps the same key; searches match both peppers', () => {
    const [m1, m2, p1, p2] = [k(), k(), k(), k()];
    const before = createFieldCrypto(m1, p1);
    const wrapped = before.newWrappedKey(5);
    const dek = before.unwrapKey(5, wrapped);
    const during = createFieldCrypto(m2, p2, { masterKey: m1, pepper: p1 });
    expect(during.unwrapKey(5, wrapped).equals(dek)).toBe(true);
    const rewrapped = during.rewrapKey(5, wrapped);
    expect(createFieldCrypto(m2, p2).unwrapKey(5, rewrapped).equals(dek)).toBe(true);
    expect(() => createFieldCrypto(m2, p2).unwrapKey(5, wrapped)).toThrow();
    expect(during.searchDigests('IQAMA', '2123456789')).toEqual([createFieldCrypto(m2, p2).blindIndex('IQAMA', '2123456789'), before.blindIndex('IQAMA', '2123456789')]);
    expect(during.masterKeyId).toBe(keyId(m2));
    expect(during.pepperId).toBe(keyId(p2));
    expect(keyId(m1)).not.toBe(keyId(m2));
  });

  it('vault: reads objects under the previous key and re-wraps them in place', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rot-'));
    try {
      const [oldKek, newKek] = [k(), k()];
      const adapter = createLocalDiskAdapter(root);
      const key = await createVault(adapter, oldKek).put(FILES.pdf);
      const during = createVault(adapter, newKek, oldKek);
      expect((await during.get(key, sha(FILES.pdf))).equals(FILES.pdf)).toBe(true);
      await expect(createVault(adapter, newKek).get(key, sha(FILES.pdf))).rejects.toBeInstanceOf(VaultIntegrityError);
      expect(await during.rewrap(key, sha(FILES.pdf), { dryRun: true })).toBe('rewrapped');
      await expect(createVault(adapter, newKek).get(key, sha(FILES.pdf))).rejects.toBeInstanceOf(VaultIntegrityError); // dry run wrote nothing
      expect(await during.rewrap(key, sha(FILES.pdf))).toBe('rewrapped');
      expect(await during.rewrap(key, sha(FILES.pdf))).toBe('current');
      expect((await createVault(adapter, newKek).get(key, sha(FILES.pdf))).equals(FILES.pdf)).toBe(true);
      await expect(createVault(adapter, oldKek).get(key, sha(FILES.pdf))).rejects.toBeInstanceOf(VaultIntegrityError);
      await expect(during.rewrap(key, 'f'.repeat(64))).resolves.toBe('current'); // already current: nothing to check
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('configuration: a previous key needs a new one, and in production differs from every other key', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'x'.repeat(40) };
    expect(() => loadEnv({ ...base, MFA_ENCRYPTION_KEY_PREVIOUS: b64(k()) })).toThrow(/MFA_ENCRYPTION_KEY_PREVIOUS: set only together with a new MFA_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, DOCUMENT_ENCRYPTION_KEY: b64(k()), DOCUMENT_ENCRYPTION_KEY_PREVIOUS: 'short' })).toThrow(/32 random bytes/);
    const keys = { MFA_ENCRYPTION_KEY: b64(k()), DOCUMENT_ENCRYPTION_KEY: b64(k()), PDPL_FIELD_ENCRYPTION_KEY: b64(k()), PDPL_BLIND_INDEX_PEPPER: b64(k()) };
    const prod = { ...base, NODE_ENV: 'production', ...keys };
    expect(() => loadEnv({ ...prod, PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS: keys.PDPL_FIELD_ENCRYPTION_KEY })).toThrow(/must differ from PDPL_FIELD_ENCRYPTION_KEY/);
    expect(loadEnv({ ...prod, PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS: b64(k()) }).PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS).toHaveLength(44);
  });
});

describeDb('rotating every key end to end (B-18)', () => {
  let db: Db;
  let root: string;
  beforeAll(async () => {
    db = openDb();
    root = await mkdtemp(path.join(os.tmpdir(), 'rot-api-'));
  });
  afterAll(async () => { await db.$disconnect(); await rm(root, { recursive: true, force: true }); });

  it('old keys → both → new keys only: data stays readable and searchable throughout', async () => {
    const OLD = { MFA_ENCRYPTION_KEY: b64(k()), DOCUMENT_ENCRYPTION_KEY: b64(k()), PDPL_FIELD_ENCRYPTION_KEY: b64(k()), PDPL_BLIND_INDEX_PEPPER: b64(k()), STORAGE_DIR: root };
    const NEW = { MFA_ENCRYPTION_KEY: b64(k()), DOCUMENT_ENCRYPTION_KEY: b64(k()), PDPL_FIELD_ENCRYPTION_KEY: b64(k()), PDPL_BLIND_INDEX_PEPPER: b64(k()), STORAGE_DIR: root };
    const BOTH = {
      ...NEW, MFA_ENCRYPTION_KEY_PREVIOUS: OLD.MFA_ENCRYPTION_KEY, DOCUMENT_ENCRYPTION_KEY_PREVIOUS: OLD.DOCUMENT_ENCRYPTION_KEY,
      PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS: OLD.PDPL_FIELD_ENCRYPTION_KEY, PDPL_BLIND_INDEX_PEPPER_PREVIOUS: OLD.PDPL_BLIND_INDEX_PEPPER,
    };
    const org = await makeOrg(db);
    const hrUser = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const saUser = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true });
    await db.credentialCategory.upsert({ where: { code: 'IDENTITY' }, update: {}, create: { code: 'IDENTITY', name: 'Identity' } });
    const t = await db.credentialTemplate.create({ data: { code: uniq('IQ').toUpperCase(), name: 'Iqama', categoryCode: 'IDENTITY', hasExpiry: true, requiresUpload: false } });
    const defs: FieldDef[] = [
      { key: 'iqama_number', label: 'Iqama number', type: 'text', required: true, displayOrder: 1, pdplCategory: 'IQAMA' },
      { key: 'expiry_date', label: 'Expiry', type: 'date', required: true, displayOrder: 2, isExpiryDate: true },
    ];
    await db.credentialTemplateField.createMany({ data: fieldRows(t.id, defs) });

    // Under the old keys: an Iqama, a scan, an authenticator seed.
    const hrOld = await signIn(testApp(db, OLD), hrUser.email);
    const { emp } = await makeNurse(db, org.unitA.id);
    const iqama = String(2_000_000_000 + Math.floor(Math.random() * 999_999_999));
    const credId = (await hrOld.post('/credentials', { employeeId: emp.id, templateId: t.id, trackingData: { iqama_number: iqama, expiry_date: '2029-01-01' } })).body.id;
    const docId = (await hrOld.upload(`/credentials/${credId}/documents`, FILES.pdf, 'application/pdf', 'iqama.pdf')).body.id;
    const mfaUser = await makeUser(db);
    await db.mfaFactor.create({ data: { userId: mfaUser.id, secretEnc: createSecretBox(mfaKey(testEnv(OLD))).seal('JBSWY3DPEHPK3PXP'), confirmedAt: new Date() } });

    // Both keys configured: everything reads; health says the rotation is not finished.
    const appBoth = testApp(db, BOTH);
    const hrBoth = await signIn(appBoth, hrUser.email);
    expect((await hrBoth.get(`/credentials/${credId}`)).body.trackingData.iqama_number).toBe(iqama);
    expect((await hrBoth.get(`/credentials?identifier=${iqama}`)).body.items.map((c: { id: number }) => c.id)).toEqual([credId]);
    expect((await hrBoth.get(`/credentials/${credId}/documents/${docId}`)).status).toBe(200);
    const health = (await (await signIn(appBoth, saUser.email)).get('/system/health/business')).body;
    expect(health.keys.previousConfigured).toEqual(['MFA_ENCRYPTION_KEY_PREVIOUS', 'DOCUMENT_ENCRYPTION_KEY_PREVIOUS', 'PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS', 'PDPL_BLIND_INDEX_PEPPER_PREVIOUS']);
    expect(health.issues.map((i: { code: string }) => i.code)).toContain('KEY_ROTATION_PENDING');

    // keys:rotate with both configured. (The shared test database also holds rows under the suite's own keys; those fail here and are left untouched.)
    const env = testEnv(BOTH);
    const deps = {
      protection: createProtection(fieldCryptoFromEnv(env)),
      box: createSecretBox(mfaKey(env), previousKey(env.MFA_ENCRYPTION_KEY_PREVIOUS)),
      vault: createVault(createLocalDiskAdapter(root), documentKey(env), previousKey(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS)),
      mfaRotating: true, documentsRotating: true,
    };
    const doc = await db.documentVersion.findUniqueOrThrow({ where: { id: docId } });
    const before = await readFile(path.join(root, doc.storageKey.slice(0, 2), doc.storageKey));
    const dry = await rotateKeys(db, deps, { check: true });
    expect(dry.documents.pending).toBe(1);
    expect(dry.mfaSeeds.pending).toBe(1);
    expect((await readFile(path.join(root, doc.storageKey.slice(0, 2), doc.storageKey))).equals(before)).toBe(true);
    const out = await rotateKeys(db, deps);
    expect(out.documents.rotated).toBe(1);
    expect(out.mfaSeeds.rotated).toBe(1);
    expect(out.employeeKeys.rotated).toBeGreaterThanOrEqual(1);
    expect(out.employeeKeys.failed).not.toContain(emp.id);
    expect(out.searchIndex.failed).not.toContain(credId);
    const fc = fieldCryptoFromEnv(env);
    expect((await db.employeeKey.findUniqueOrThrow({ where: { employeeId: emp.id } })).keyVersion).toBe(fc.masterKeyId);
    expect((await db.pdplIdentifierIndex.findMany({ where: { credentialId: credId } })).map((r) => r.keyVersion)).toEqual([fc.pepperId]);
    expect(await db.auditEntry.count({ where: { action: 'KEYS_ROTATED', createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBeGreaterThanOrEqual(1);

    // New keys only: nothing needs the old ones any more.
    const hrNew = await signIn(testApp(db, NEW), hrUser.email);
    expect((await hrNew.get(`/credentials/${credId}`)).body.trackingData.iqama_number).toBe(iqama);
    expect((await hrNew.get(`/credentials?identifier=${iqama}`)).body.items.map((c: { id: number }) => c.id)).toEqual([credId]);
    const file = await hrNew.get(`/credentials/${credId}/documents/${docId}`);
    expect(file.status).toBe(200);
    expect(Buffer.from(file.body).equals(FILES.pdf)).toBe(true);
    const seed = await db.mfaFactor.findUniqueOrThrow({ where: { userId: mfaUser.id } });
    expect(createSecretBox(mfaKey(testEnv(NEW))).open(seed.secretEnc)).toBe('JBSWY3DPEHPK3PXP');
    const newIds = fieldCryptoFromEnv(testEnv(NEW));
    const after = await businessHealth(db, new Date(), { masterKeyId: newIds.masterKeyId, pepperId: newIds.pepperId, previous: [] });
    expect(after.keys!.previousConfigured).toEqual([]);
    // A second run has nothing of ours left to move.
    const again = await rotateKeys(db, deps, { check: true });
    expect(again.documents.pending).toBe(0);
    expect(again.mfaSeeds.pending).toBe(0);
  });
});
