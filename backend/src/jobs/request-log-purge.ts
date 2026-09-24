// Deletes request-log rows (spec §9.2) older than the retention period, in
// chunks so a large first purge never holds a long lock. Daily at 02:30 Riyadh.

import type { Db } from '../lib/prisma.js';
import { RETENTION_DAYS } from '../lib/request-log.js';

const CHUNK = 10_000;

export async function requestLogPurge(db: Db, now = new Date()) {
  const before = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  let deleted = 0;
  for (;;) {
    const n = await db.$executeRaw`
      DELETE FROM request_audit_log WHERE id IN (SELECT id FROM request_audit_log WHERE at < ${before} ORDER BY id LIMIT ${CHUNK})`;
    deleted += n;
    if (n < CHUNK) break;
  }
  return { before: before.toISOString(), deleted, retentionDays: RETENTION_DAYS };
}
