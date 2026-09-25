// Key rotation (B-18): moves everything still under a previous key to the
// current one. The runbook (docs/DEPLOYMENT.md §3, "Rotating a key"):
//
//   1. Put the new key in the variable and the old one in <NAME>_PREVIOUS;
//      restart the API and the worker. Both keys now read; new data uses the new key.
//   2. npm run keys:rotate -w backend            (container: node dist/cli/keys-rotate.js)
//   3. When it reports nothing left, remove <NAME>_PREVIOUS and restart.
//
// What moves:
// - PDPL_FIELD_ENCRYPTION_KEY: each employee's data key is re-wrapped (the
//   values sealed with it do not change);
// - PDPL_BLIND_INDEX_PEPPER: the identifier search index is rebuilt;
// - MFA_ENCRYPTION_KEY: authenticator seeds are re-sealed;
// - DOCUMENT_ENCRYPTION_KEY: each stored file's data key is re-wrapped in place.
// Safe to interrupt and to run again. `--check` only counts.

import 'dotenv/config';
import { appendAudit } from '../lib/audit.js';
import { loadEnv } from '../config/env.js';
import { fieldCryptoFromEnv } from '../lib/field-crypto.js';
import { previousKey } from '../lib/keyring.js';
import { createPrisma, type Db } from '../lib/prisma.js';
import { createSecretBox, mfaKey, type SecretBox } from '../lib/secret-box.js';
import { createLocalDiskAdapter, createVault, documentKey, type Vault } from '../lib/vault.js';
import { presentTemplate, WITH_FIELDS } from '../modules/credentials/fields.js';
import { createProtection, type Protection, type TrackingValues } from '../modules/pdpl/protection.js';

interface Count { pending: number; rotated: number; failed: number[] }
const count = (): Count => ({ pending: 0, rotated: 0, failed: [] });

export interface RotationDeps { protection: Protection; box: SecretBox; vault: Vault; mfaRotating: boolean; documentsRotating: boolean }

export async function rotateKeys(db: Db, { protection, box, vault, mfaRotating, documentsRotating }: RotationDeps, { check = false } = {}) {
  const { crypto } = protection;
  const out = { employeeKeys: count(), searchIndex: count(), mfaSeeds: count(), documents: count() };

  // 1. Employee data keys not wrapped under the current master key.
  const keys = await db.employeeKey.findMany({ where: { wrappedKey: { not: null }, keyVersion: { not: crypto.masterKeyId } }, select: { employeeId: true, wrappedKey: true } });
  out.employeeKeys.pending = keys.length;
  for (const k of keys) {
    if (check) continue;
    try {
      const wrappedKey = crypto.rewrapKey(k.employeeId, k.wrappedKey!);
      // Only while still live: an erasure between the read and here wins.
      const n = await db.employeeKey.updateMany({ where: { employeeId: k.employeeId, wrappedKey: k.wrappedKey }, data: { wrappedKey, keyVersion: crypto.masterKeyId } });
      out.employeeKeys.rotated += n.count;
    } catch {
      out.employeeKeys.failed.push(k.employeeId);
    }
  }

  // 2. Search digests made with another pepper: rebuilt from the (opened) current values.
  const stale = await db.pdplIdentifierIndex.findMany({ where: { keyVersion: { not: crypto.pepperId } }, select: { credentialId: true }, distinct: ['credentialId'] });
  out.searchIndex.pending = stale.length;
  for (const { credentialId } of stale) {
    if (check) continue;
    try {
      await db.$transaction(async (tx) => {
        const c = await tx.credential.findUniqueOrThrow({ where: { id: credentialId }, include: { template: { include: WITH_FIELDS } } });
        const opened = await protection.reveal(tx, c.employeeId, c.trackingData);
        if (opened.erased) await tx.pdplIdentifierIndex.deleteMany({ where: { credentialId } });
        else await protection.index(tx, credentialId, presentTemplate(c.template).fieldDefs, opened.data as TrackingValues);
      });
      out.searchIndex.rotated++;
    } catch {
      out.searchIndex.failed.push(credentialId);
    }
  }

  // 3. Authenticator seeds sealed under the previous MFA key.
  if (mfaRotating) {
    for (const f of await db.mfaFactor.findMany({ select: { userId: true, secretEnc: true } })) {
      try {
        if (!box.isOld(f.secretEnc)) continue;
        out.mfaSeeds.pending++;
        if (check) continue;
        const n = await db.mfaFactor.updateMany({ where: { userId: f.userId, secretEnc: f.secretEnc }, data: { secretEnc: box.seal(box.open(f.secretEnc)) } });
        out.mfaSeeds.rotated += n.count;
      } catch {
        out.mfaSeeds.failed.push(f.userId);
      }
    }
  }

  // 4. Stored files whose data key is wrapped under the previous document key.
  if (documentsRotating) {
    for (const d of await db.documentVersion.findMany({ where: { erasedAt: null }, select: { id: true, storageKey: true, sha256: true }, orderBy: { id: 'asc' } })) {
      try {
        const r = await vault.rewrap(d.storageKey, d.sha256, { dryRun: check });
        if (r === 'rewrapped') {
          out.documents.pending++;
          if (!check) out.documents.rotated++;
        }
      } catch {
        out.documents.failed.push(d.id);
      }
    }
  }

  const moved = out.employeeKeys.rotated + out.searchIndex.rotated + out.mfaSeeds.rotated + out.documents.rotated;
  if (!check && moved > 0) {
    await appendAudit(db, {
      actorUserId: null, action: 'KEYS_ROTATED', resource: 'system', priority: 'HIGH',
      changes: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { rotated: v.rotated, failed: v.failed.length }])),
    });
  }
  const failed = Object.values(out).reduce((n, v) => n + v.failed.length, 0);
  const left = check ? Object.values(out).reduce((n, v) => n + v.pending, 0) : Object.values(out).reduce((n, v) => n + v.pending - v.rotated, 0);
  return { ...out, done: failed === 0 && left === 0 };
}

async function main() {
  const check = process.argv.includes('--check');
  const env = loadEnv();
  const db = createPrisma(env.DATABASE_URL);
  try {
    const out = await rotateKeys(db, {
      protection: createProtection(fieldCryptoFromEnv(env)),
      box: createSecretBox(mfaKey(env), previousKey(env.MFA_ENCRYPTION_KEY_PREVIOUS)),
      vault: createVault(createLocalDiskAdapter(env.STORAGE_DIR), documentKey(env), previousKey(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS)),
      mfaRotating: Boolean(env.MFA_ENCRYPTION_KEY_PREVIOUS),
      documentsRotating: Boolean(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS),
    }, { check });
    console.log(JSON.stringify(out, null, 2));
    if (!out.done) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /keys-rotate\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
