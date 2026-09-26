// Deletes messages the mock Telegram gateway intercepted (D-66) once they are
// older than MOCK_TELEGRAM_RETENTION_DAYS: they hold chat ids, and a
// demonstration needs only the recent ones. Daily at 02:40 Riyadh.

import type { Db } from '../lib/prisma.js';

export const MOCK_TELEGRAM_RETENTION_DAYS = 30;

export async function mockTelegramPurge(db: Db, now = new Date()) {
  const before = new Date(now.getTime() - MOCK_TELEGRAM_RETENTION_DAYS * 86_400_000);
  const { count } = await db.mockTelegramOutbox.deleteMany({ where: { createdAt: { lt: before } } });
  return { before: before.toISOString(), deleted: count, retentionDays: MOCK_TELEGRAM_RETENTION_DAYS };
}
