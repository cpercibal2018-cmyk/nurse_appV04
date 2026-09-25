// Daily vault check (spec §5.3.1 "reconcile orphaned objects", D-53), 04:30 Riyadh:
// - removes stored objects no document row points to, once older than a day
//   (an upload whose database transaction failed after the bytes were written);
// - lists rows whose object is missing;
// - re-verifies a random sample of documents end to end (decrypt + SHA-256);
// - counts objects still in plaintext (written before the vault; run
//   `npm run vault:encrypt`);
// - deletes download links older than a day;
// - removes the objects of files erased with an employee's personal data
//   (spec §8.3.3, D-55) that the erasure itself could not remove.
// Any missing object or failed check notifies the System Admins; Administration
// → Jobs → System health shows the last result.

import { loadEnv } from '../config/env.js';
import type { Db } from '../lib/prisma.js';
import { riyadhDate } from '../lib/dates.js';
import { previousKey } from '../lib/keyring.js';
import { createLocalDiskAdapter, createVault, documentKey, type Vault } from '../lib/vault.js';

export const ORPHAN_GRACE_HOURS = 24;
export const SAMPLE_SIZE = 50;

export async function reconcileVault(db: Db, vault: Vault, now = new Date()) {
  const all = await db.documentVersion.findMany({ select: { id: true, storageKey: true, erasedAt: true } });
  const rows = all.filter((r) => !r.erasedAt);
  const erasedKeys = new Set(all.filter((r) => r.erasedAt).map((r) => r.storageKey));
  const byKey = new Map(rows.map((r) => [r.storageKey, r.id]));
  const seen = new Set<string>();
  let objects = 0;
  let orphansRemoved = 0;
  let legacyPlaintext = 0;
  let erasedRemoved = 0;
  for await (const { key, modifiedAt } of vault.adapter.list()) {
    objects++;
    if (erasedKeys.has(key)) {
      await vault.adapter.remove(key);
      erasedRemoved++;
      continue;
    }
    seen.add(key);
    if (!byKey.has(key)) {
      if (now.getTime() - modifiedAt.getTime() > ORPHAN_GRACE_HOURS * 3600_000) {
        await vault.adapter.remove(key);
        orphansRemoved++;
      }
      continue;
    }
    if (!(await vault.isEncrypted(key))) legacyPlaintext++;
  }
  const missingDocumentIds = rows.filter((r) => !seen.has(r.storageKey)).map((r) => r.id).sort((a, b) => b - a); // newest first

  const sample = await db.$queryRaw<Array<{ id: number; storage_key: string; sha256: string }>>`
    SELECT id, storage_key, sha256 FROM document_versions WHERE scan_status = 'CLEAN' AND erased_at IS NULL ORDER BY random() LIMIT ${SAMPLE_SIZE}`;
  const failedDocumentIds: number[] = [];
  let sampled = 0;
  for (const d of sample) {
    if (!seen.has(d.storage_key)) continue; // already counted as missing
    sampled++;
    try { await vault.get(d.storage_key, d.sha256); } catch { failedDocumentIds.push(d.id); }
  }

  const linksPurged = (await db.downloadLink.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 86_400_000) } } })).count;

  let notified = 0;
  if (missingDocumentIds.length > 0 || failedDocumentIds.length > 0) {
    const admins = await db.roleAssignment.findMany({
      where: { role: 'SYSTEM_ADMIN', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], user: { isActive: true } },
      select: { userId: true }, distinct: ['userId'],
    });
    const detail = `${missingDocumentIds.length} missing, ${failedDocumentIds.length} failed the integrity check`;
    notified = (await db.notification.createMany({
      data: admins.map((a) => ({
        recipientId: a.userId, type: 'SYSTEM' as const, priority: 'HIGH' as const,
        title: 'Document storage problem',
        message: `The daily document vault check found stored files that cannot be served: ${detail}. Details are in Nursing Administration → Jobs; restore the files from backup.`,
        titleAr: 'مشكلة في تخزين المستندات',
        messageAr: `وجد الفحص اليومي لمخزن المستندات ملفات لا يمكن تقديمها: ${missingDocumentIds.length} مفقود، ${failedDocumentIds.length} فشل في فحص السلامة.`,
        eventKey: `vault-reconcile:${riyadhDate(now)}`,
      })),
      skipDuplicates: true,
    })).count;
  }

  return {
    storage: vault.adapter.kind, objects, documents: rows.length, orphansRemoved,
    missing: missingDocumentIds.length, missingDocumentIds: missingDocumentIds.slice(0, 20),
    sampled, integrityFailures: failedDocumentIds.length, failedDocumentIds: failedDocumentIds.slice(0, 20),
    legacyPlaintext, linksPurged, erasedRemoved, notified,
  };
}

/** The scheduled job: the vault as the API configures it. */
export function vaultReconcile(db: Db, now = new Date()) {
  const env = loadEnv();
  return reconcileVault(db, createVault(createLocalDiskAdapter(env.STORAGE_DIR), documentKey(env), previousKey(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS)), now);
}
