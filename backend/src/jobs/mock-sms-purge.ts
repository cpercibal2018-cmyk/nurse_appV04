// Deletes texts the mock SMS gateway intercepted (D-59) once they are older than
// MOCK_SMS_RETENTION_DAYS: they hold phone numbers, and a demonstration needs
// only the recent ones. Daily at 02:40 Riyadh.

import type { Db } from '../lib/prisma.js';

export const MOCK_SMS_RETENTION_DAYS = 30;

export async function mockSmsPurge(db: Db, now = new Date()) {
  const before = new Date(now.getTime() - MOCK_SMS_RETENTION_DAYS * 86_400_000);
  const { count } = await db.mockSmsOutbox.deleteMany({ where: { createdAt: { lt: before } } });
  return { before: before.toISOString(), deleted: count, retentionDays: MOCK_SMS_RETENTION_DAYS };
}
