// Document vault (spec §5.3.1, D-53): encryption at rest, integrity on read,
// single-use download links, reconciliation and the legacy migration.

import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { createLocalDiskAdapter, createVault, documentKey, newObjectKey, VaultIntegrityError, type Vault } from '../src/lib/vault.js';
import { reconcileVault } from '../src/jobs/vault-reconcile.js';
import { encryptLegacyObjects } from '../src/cli/vault-encrypt.js';
import { loadEnv } from '../src/config/env.js';
import { FILES, makeNurse, makeOrg, makeTemplate, makeUser, openDb, signIn, TEST_URL, testApp, testEnv } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const objectPath = (root: string, key: string) => path.join(root, key.slice(0, 2), key);

describe('vault library', () => {
  let root: string;
  let vault: Vault;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vault-'));
    vault = createVault(createLocalDiskAdapter(root), crypto.randomBytes(32));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('stores ciphertext and reads the original bytes back', async () => {
    const bytes = Buffer.concat([FILES.pdf, Buffer.from('Iqama 2123456789 — personal data')]);
    const key = await vault.put(bytes);
    const onDisk = await readFile(objectPath(root, key));
    expect(onDisk.subarray(0, 8).toString('latin1')).toBe('AIGHVLT1');
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);
    expect(onDisk.includes(Buffer.from('2123456789'))).toBe(false);
    expect((await vault.get(key, sha(bytes))).equals(bytes)).toBe(true);
    expect(await vault.isEncrypted(key)).toBe(true);
    // Two uploads of the same file are different objects with different ciphertext.
    const again = await vault.put(bytes);
    expect(again).not.toBe(key);
    expect((await readFile(objectPath(root, again))).equals(onDisk)).toBe(false);
  });

  it('refuses altered bytes, another key, a moved object and a wrong checksum', async () => {
    const bytes = FILES.png;
    const key = await vault.put(bytes);
    const file = objectPath(root, key);
    const good = await readFile(file);
    await expect(vault.get(key, sha(Buffer.from('other')))).rejects.toBeInstanceOf(VaultIntegrityError);
    await expect(createVault(createLocalDiskAdapter(root), crypto.randomBytes(32)).get(key, sha(bytes))).rejects.toBeInstanceOf(VaultIntegrityError);
    const tampered = Buffer.from(good);
    tampered[tampered.length - 20]! ^= 0xff;
    await writeFile(file, tampered);
    await expect(vault.get(key, sha(bytes))).rejects.toThrow(/decrypted/);
    // The object is bound to its key: the same ciphertext under another key does not open.
    const other = newObjectKey();
    await mkdir(path.dirname(objectPath(root, other)), { recursive: true });
    await writeFile(objectPath(root, other), good);
    await expect(vault.get(other, sha(bytes))).rejects.toBeInstanceOf(VaultIntegrityError);
  });

  it('reads legacy plaintext objects, never overwrites, rejects bad keys, and lists what it holds', async () => {
    const legacy = newObjectKey();
    await vault.adapter.create(legacy, FILES.pdf);
    expect(await vault.isEncrypted(legacy)).toBe(false);
    expect((await vault.get(legacy, sha(FILES.pdf))).equals(FILES.pdf)).toBe(true);
    await expect(vault.adapter.create(legacy, FILES.png)).rejects.toThrow();
    await expect(vault.adapter.read('../../etc/passwd')).rejects.toThrow(/invalid storage key/);
    const keys: string[] = [];
    for await (const o of vault.adapter.list()) keys.push(o.key);
    expect(keys).toContain(legacy);
    expect(() => createVault(vault.adapter, crypto.randomBytes(16))).toThrow(/32 bytes/);
  });

  it('production requires its own document key', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'x'.repeat(40), MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), PDPL_FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), PDPL_BLIND_INDEX_PEPPER: Buffer.alloc(32, 4).toString('base64') };
    expect(() => loadEnv(base)).toThrow(/DOCUMENT_ENCRYPTION_KEY: required in production/);
    expect(() => loadEnv({ ...base, DOCUMENT_ENCRYPTION_KEY: base.MFA_ENCRYPTION_KEY })).toThrow(/must differ from MFA_ENCRYPTION_KEY/);
    expect(loadEnv({ ...base, DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') }).DOCUMENT_ENCRYPTION_KEY).toHaveLength(44);
    expect(documentKey({ DOCUMENT_ENCRYPTION_KEY: '', JWT_SECRET: 'x'.repeat(40) })).toHaveLength(32);
  });
});

describeDb('document vault through the API (D-53)', () => {
  let db: Db;
  let root: string;
  let app: Express;
  let vault: Vault;
  let hr: Awaited<ReturnType<typeof signIn>>;
  let credentialId: number;
  let org: Awaited<ReturnType<typeof makeOrg>>;

  beforeAll(async () => {
    db = openDb();
    root = await mkdtemp(path.join(os.tmpdir(), 'vault-api-'));
    app = testApp(db, { STORAGE_DIR: root });
    vault = createVault(createLocalDiskAdapter(root), documentKey(testEnv()));
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    const { emp } = await makeNurse(db, org.unitA.id);
    const tpl = await makeTemplate(db);
    credentialId = (await hr.post('/credentials', { employeeId: emp.id, templateId: tpl.id, trackingData: { licence_number: 'L-1', issue_date: '2026-01-01', expiry_date: '2027-12-31' } })).body.id;
  });
  afterAll(async () => { await db.$disconnect(); await rm(root, { recursive: true, force: true }); });

  const upload = async () => (await hr.upload(`/credentials/${credentialId}/documents`, FILES.pdf, 'application/pdf', 'licence.pdf')).body.id as number;
  const docPath = (id: number) => `/credentials/${credentialId}/documents/${id}`;

  it('an upload is stored encrypted; a download returns the original file', async () => {
    const id = await upload();
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    const onDisk = await readFile(objectPath(root, row.storageKey));
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);
    const res = await hr.get(docPath(id));
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(FILES.pdf)).toBe(true);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('a link opens the file once, within 60 seconds, without the access token — and never shows up in the logs', async () => {
    const id = await upload();
    const link = await hr.post(`${docPath(id)}/link`, {});
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(/^\/api\/v1\/files\/[A-Za-z0-9_-]{43}\/licence\.pdf$/);
    const seconds = (new Date(link.body.expiresAt).getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(55);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(await db.downloadLink.count({ where: { tokenHash: link.body.url.split('/')[4] } })).toBe(0); // only the hash is stored

    const open = await request(app).get(link.body.url);
    expect(open.status).toBe(200);
    expect(Buffer.from(open.body).equals(FILES.pdf)).toBe(true);
    expect(open.headers['content-type']).toBe('application/pdf');
    expect(open.headers['content-disposition']).toMatch(/^inline; filename\*=UTF-8''licence\.pdf$/);
    expect(open.headers['content-security-policy']).toContain("default-src 'none'");
    expect(open.headers['x-content-type-options']).toBe('nosniff');
    expect((await request(app).get(link.body.url)).body.error.code).toBe('LINK_INVALID'); // single use

    await (app.locals.requestLog as { flush: () => Promise<void> }).flush();
    const logged = await db.requestLogEntry.findFirst({ where: { requestId: open.headers['x-request-id'] } });
    expect(logged?.path).toBe('/api/v1/files/:token');
    expect(logged?.actorUserId).toBeNull();
    const audits = await db.auditEntry.findMany({ where: { resource: 'credential', resourceId: String(credentialId), action: { in: ['DOCUMENT_LINK_ISSUED', 'DOCUMENT_DOWNLOADED'] } }, orderBy: { id: 'desc' }, take: 2 });
    expect(audits.map((a) => [a.action, (a.changes as { via?: string }).via ?? null])).toEqual([['DOCUMENT_DOWNLOADED', 'link'], ['DOCUMENT_LINK_ISSUED', null]]);

    const save = await hr.post(`${docPath(id)}/link`, { inline: false });
    expect((await request(app).get(save.body.url)).headers['content-disposition']).toMatch(/^attachment/);
  });

  it('links need the same authorisation, expire, and die with the account', async () => {
    const id = await upload();
    const stranger = await signIn(app, (await makeUser(db)).email);
    expect((await stranger.post(`${docPath(id)}/link`, {})).status).toBe(403);
    expect((await request(app).post(`/api/v1${docPath(id)}/link`).send({})).status).toBe(401);
    expect((await request(app).get('/api/v1/files/not-a-token')).body.error.code).toBe('LINK_INVALID');

    const expiring = await hr.post(`${docPath(id)}/link`, {});
    await db.downloadLink.updateMany({ where: { usedAt: null, documentId: id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await request(app).get(expiring.body.url)).status).toBe(404);

    const other = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const otherClient = await signIn(app, other.email);
    const pending = await otherClient.post(`${docPath(id)}/link`, {});
    await db.user.update({ where: { id: other.id }, data: { isActive: false } });
    expect((await request(app).get(pending.body.url)).status).toBe(404);
    await expect(db.downloadLink.create({ data: { tokenHash: crypto.randomUUID(), documentId: id, userId: other.id, expiresAt: new Date(Date.now() + 3600_000) } }))
      .rejects.toThrow(/chk_download_links_window/);
  });

  it('an altered or missing object is never served, and the incident is audited HIGH', async () => {
    const id = await upload();
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    const file = objectPath(root, row.storageKey);
    const good = await readFile(file);
    const bad = Buffer.from(good);
    bad[bad.length - 30]! ^= 0x01;
    await writeFile(file, bad);
    const res = await hr.get(docPath(id));
    expect([res.status, res.body.error.code]).toEqual([500, 'DOCUMENT_INTEGRITY_FAILED']);
    expect(await db.auditEntry.count({ where: { action: 'DOCUMENT_INTEGRITY_FAILED', priority: 'HIGH', resourceId: String(credentialId) } })).toBeGreaterThanOrEqual(1);
    await rm(file);
    expect((await hr.get(docPath(id))).body.error.code).toBe('DOCUMENT_MISSING');
    await writeFile(file, good); // restored from backup: served again
    expect((await hr.get(docPath(id))).status).toBe(200);
  });

  it('the legacy migration encrypts plaintext objects once, and the files still open', async () => {
    const id = await upload();
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    // Simulate a pre-vault object: plaintext under its own key.
    const legacyKey = newObjectKey();
    await vault.adapter.create(legacyKey, FILES.pdf);
    await db.documentVersion.update({ where: { id }, data: { storageKey: legacyKey } });
    await vault.adapter.remove(row.storageKey);
    expect((await hr.get(docPath(id))).status).toBe(200); // legacy still readable

    const out = await encryptLegacyObjects(db, vault);
    expect(out.encrypted).toBeGreaterThanOrEqual(1);
    const after = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    expect(after.storageKey).not.toBe(legacyKey);
    expect(await vault.isEncrypted(after.storageKey)).toBe(true);
    await expect(readFile(objectPath(root, legacyKey))).rejects.toThrow();
    expect(Buffer.from((await hr.get(docPath(id))).body).equals(FILES.pdf)).toBe(true);
    const again = await encryptLegacyObjects(db, vault);
    expect(again.encrypted).toBe(0);
  });

  it('the daily reconcile removes old orphans, keeps new ones, reports missing objects and purges old links', async () => {
    const oldOrphan = await vault.put(FILES.png);
    const newOrphan = await vault.put(FILES.png);
    const old = new Date(Date.now() - 48 * 3600_000);
    await utimes(objectPath(root, oldOrphan), old, old);
    const id = await upload();
    const row = await db.documentVersion.findUniqueOrThrow({ where: { id } });
    await rm(objectPath(root, row.storageKey)); // lost from storage
    const u = await makeUser(db);
    await db.downloadLink.create({ data: { tokenHash: crypto.randomUUID(), documentId: id, userId: u.id, createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 2 * 86_400_000 + 60_000) } });

    const out = await reconcileVault(db, vault);
    expect(out.orphansRemoved).toBe(1);
    await expect(readFile(objectPath(root, oldOrphan))).rejects.toThrow();
    expect((await readFile(objectPath(root, newOrphan))).length).toBeGreaterThan(0);
    expect(out.missing).toBeGreaterThanOrEqual(1);
    expect(out.missingDocumentIds[0]).toBe(id); // newest first
    expect(out.legacyPlaintext).toBe(0);
    expect(out.linksPurged).toBeGreaterThanOrEqual(1);
    expect(out.storage).toBe('local-disk');
  });
});
