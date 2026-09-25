// Protects sensitive values stored before D-54, or before a field was marked
// sensitive: each plaintext Iqama / passport / SCFHS value (approved or staged
// in a renewal) is sealed with the employee's key and the blind index is
// rebuilt. Safe to interrupt and to run again.
//
//   npm run build -w backend && npm run pdpl:protect -w backend

import 'dotenv/config';
import { appendAudit } from '../lib/audit.js';
import { loadEnv } from '../config/env.js';
import { fieldCryptoFromEnv, isSealed } from '../lib/field-crypto.js';
import { createPrisma, Prisma, type Db } from '../lib/prisma.js';
import { createProtection, type Protection, type TrackingValues } from '../modules/pdpl/protection.js';
import { presentTemplate, WITH_FIELDS } from '../modules/credentials/fields.js';

export async function protectExisting(db: Db, protection: Protection) {
  const templates = (await db.credentialTemplate.findMany({ include: WITH_FIELDS })).map(presentTemplate)
    .filter((t) => t.fieldDefs.some((f) => f.pdplCategory));
  let sealed = 0;
  let indexed = 0;
  const failed: Array<{ credentialId: number; error: string }> = [];
  for (const t of templates) {
    const creds = await db.credential.findMany({ where: { templateId: t.id }, select: { id: true, employeeId: true, trackingData: true, pendingData: true } });
    for (const c of creds) {
      try {
        await db.$transaction(async (tx) => {
          const data = (c.trackingData ?? {}) as TrackingValues;
          const pending = c.pendingData as { trackingData?: TrackingValues } | null;
          const plainKeys = (d: TrackingValues | undefined) => t.fieldDefs.filter((f) => f.pdplCategory && d && d[f.key] !== undefined && d[f.key] !== '' && !isSealed(d[f.key])).length;
          const todo = plainKeys(data) + plainKeys(pending?.trackingData);
          const opened = await protection.reveal(tx, c.employeeId, data);
          const newData = await protection.seal(tx, c.employeeId, t.fieldDefs, data);
          const newPending = pending?.trackingData ? { ...pending, trackingData: await protection.seal(tx, c.employeeId, t.fieldDefs, pending.trackingData) } : pending;
          await tx.credential.update({ where: { id: c.id }, data: { trackingData: newData, pendingData: newPending ?? Prisma.DbNull } });
          if (!opened.erased) {
            await protection.index(tx, c.id, t.fieldDefs, opened.data as TrackingValues);
            indexed++;
          }
          sealed += todo;
        });
      } catch (e) {
        failed.push({ credentialId: c.id, error: (e as Error).message });
      }
    }
  }
  if (sealed > 0) await appendAudit(db, { actorUserId: null, action: 'PDPL_EXISTING_VALUES_PROTECTED', resource: 'system', changes: { sealed, indexed, failed: failed.length }, priority: 'HIGH' });
  return { templates: templates.length, sealed, indexed, failed };
}

async function main() {
  const env = loadEnv();
  const db = createPrisma(env.DATABASE_URL);
  try {
    const out = await protectExisting(db, createProtection(fieldCryptoFromEnv(env)));
    console.log(JSON.stringify(out, null, 2));
    if (out.failed.length > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && /pdpl-protect\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => { console.error((e as Error).message); process.exit(1); });
}
