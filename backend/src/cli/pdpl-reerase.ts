// Applies an erasure again after a database restore (spec §8.3.3: "the
// destroyed key is never restored"; D-55). A backup taken before an erasure
// still holds the employee's key and the request row, so after restoring it,
// run this for every "personal data erased" log line newer than the backup:
//
//   npm run pdpl:reerase -w backend -- <employeeId> [<employeeId> …]
//
// It destroys the key again, removes the search-index rows and the identity
// scans, and audits PERSONAL_DATA_ERASURE_REAPPLIED. An employee whose key is
// already destroyed is reported and skipped.

import 'dotenv/config';
import { appendAudit } from '../lib/audit.js';
import { loadEnv } from '../config/env.js';
import { fieldCryptoFromEnv } from '../lib/field-crypto.js';
import { HttpError } from '../lib/http-errors.js';
import { createPrisma, type Db } from '../lib/prisma.js';
import { createLocalDiskAdapter, createVault, documentKey, type Vault } from '../lib/vault.js';
import { createProtection, type Protection } from '../modules/pdpl/protection.js';
import { shredEmployee } from '../modules/pdpl/requests.js';

export async function reapplyErasure(db: Db, protection: Protection, vault: Vault, employeeId: number, now = new Date()) {
  try {
    const out = await db.$transaction(async (tx) => {
      const shred = await shredEmployee(tx, protection, employeeId, null, now);
      await appendAudit(tx, { actorUserId: null, action: 'PERSONAL_DATA_ERASURE_REAPPLIED', resource: 'employee', resourceId: employeeId, changes: { keyDestroyedAt: now, documentsErased: shred.storageKeys.length }, priority: 'HIGH' });
      return shred;
    });
    for (const key of out.storageKeys) await vault.adapter.remove(key).catch(() => undefined); // the daily vault check retries
    return { employeeId, status: 'ERASED' as const, documentsErased: out.storageKeys.length };
  } catch (e) {
    if (e instanceof HttpError && e.code === 'ALREADY_ERASED') return { employeeId, status: 'ALREADY_ERASED' as const, documentsErased: 0 };
    throw e;
  }
}

async function main() {
  const ids = process.argv.slice(2).map(Number);
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error('usage: pdpl-reerase <employeeId> [<employeeId> …]');
    process.exit(2);
  }
  const env = loadEnv();
  const db = createPrisma(env.DATABASE_URL);
  try {
    const protection = createProtection(fieldCryptoFromEnv(env));
    const vault = createVault(createLocalDiskAdapter(env.STORAGE_DIR), documentKey(env));
    for (const id of ids) console.log(JSON.stringify(await reapplyErasure(db, protection, vault, id)));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /pdpl-reerase\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
