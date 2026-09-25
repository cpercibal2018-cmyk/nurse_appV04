// Encrypts documents stored before the vault (D-53): each plaintext object is
// read, checked against its recorded SHA-256, written again encrypted under a
// new key, the document row is switched to the new key, and only then is the
// old object removed. Safe to interrupt and to run again; running it twice
// finds nothing to do.
//
//   npm run build -w backend && npm run vault:encrypt -w backend

import 'dotenv/config';
import { appendAudit } from '../lib/audit.js';
import { loadEnv } from '../config/env.js';
import { createPrisma, type Db } from '../lib/prisma.js';
import { previousKey } from '../lib/keyring.js';
import { createLocalDiskAdapter, createVault, documentKey, type Vault } from '../lib/vault.js';

export async function encryptLegacyObjects(db: Db, vault: Vault) {
  const rows = await db.documentVersion.findMany({ select: { id: true, storageKey: true, sha256: true }, orderBy: { id: 'asc' } });
  let encrypted = 0;
  let alreadyEncrypted = 0;
  const failed: Array<{ id: number; error: string }> = [];
  for (const r of rows) {
    try {
      if (await vault.isEncrypted(r.storageKey)) { alreadyEncrypted++; continue; }
      const bytes = await vault.get(r.storageKey, r.sha256); // verified before re-writing
      const newKey = await vault.put(bytes);
      const switched = await db.documentVersion.updateMany({ where: { id: r.id, storageKey: r.storageKey }, data: { storageKey: newKey } });
      if (switched.count === 1) {
        await vault.adapter.remove(r.storageKey);
        encrypted++;
      } else {
        await vault.adapter.remove(newKey); // the row changed meanwhile; leave it
      }
    } catch (e) {
      failed.push({ id: r.id, error: (e as Error).message });
    }
  }
  if (encrypted > 0) {
    await appendAudit(db, { actorUserId: null, action: 'VAULT_ENCRYPTED_LEGACY', resource: 'system', changes: { encrypted, alreadyEncrypted, failed: failed.length }, priority: 'HIGH' });
  }
  return { documents: rows.length, encrypted, alreadyEncrypted, failed };
}

async function main() {
  const env = loadEnv();
  const db = createPrisma(env.DATABASE_URL);
  try {
    const out = await encryptLegacyObjects(db, createVault(createLocalDiskAdapter(env.STORAGE_DIR), documentKey(env), previousKey(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS)));
    console.log(JSON.stringify(out, null, 2));
    if (out.failed.length > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /vault-encrypt\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
