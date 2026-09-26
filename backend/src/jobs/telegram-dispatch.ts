// Telegram dispatcher (D-66). Every 60 seconds, under a 10-minute processing
// lease, it announces PENDING notifications to recipients with a linked
// Telegram chat: ONE message per recipient per run, however many are waiting,
// saying only that something is waiting and where to read it — no title, no
// name, no detail (Telegram is outside the Kingdom; spec §8.3.6). Recipients
// without a linked chat, or inactive, are SKIPPED. A message the gateway does
// not accept is retried up to TELEGRAM_RETRY_MAX times, a minute apart, then
// FAILED and logged.

import type { Notification } from '../generated/prisma/client.js';
import { describeError, logger } from '../lib/logger.js';
import type { Db } from '../lib/prisma.js';
import { maskChatId, type TelegramGateway } from '../lib/telegram.js';
import { withLease } from '../lib/worker-lease.js';

export const TELEGRAM_RETRY_MAX = 5;
export const TELEGRAM_RETRY_DELAY_SECONDS = 60;
const LEASE_SECONDS = 600;
const URGENT = new Set(['CRITICAL', 'HIGH']);

export interface TelegramDispatchSummary { recipients: number; announced: number; retrying: number; failed: number; skipped: number }

/** The announcement: a count, whether any is urgent, and the link. Nothing from the notifications themselves. */
export function announcement(count: number, urgent: boolean, link: string) {
  const en = `AIGH Nursing Workforce: you have ${count === 1 ? 'a new notification' : `${count} new notifications`}${urgent ? ' (urgent)' : ''}. Sign in to read ${count === 1 ? 'it' : 'them'}: ${link}`;
  const ar = `نظام القوى العاملة التمريضية: لديك ${count === 1 ? 'إشعار جديد' : `${count} إشعارات جديدة`}${urgent ? ' (عاجل)' : ''}. سجّل الدخول لقراءتها: ${link}`;
  return `${en}\n\n${ar}`;
}

export async function dispatchTelegram(db: Db, telegram: TelegramGateway, baseUrl: string, now = new Date()): Promise<TelegramDispatchSummary> {
  const out: TelegramDispatchSummary = { recipients: 0, announced: 0, retrying: 0, failed: 0, skipped: 0 };
  // Most recipients have no chat: settle them in one statement, so they never crowd the batch below.
  const { count: skipped } = await db.notification.updateMany({
    where: { telegramStatus: 'PENDING', recipient: { OR: [{ telegramChatId: null }, { isActive: false }] } },
    data: { telegramStatus: 'SKIPPED' },
  });
  out.skipped = skipped;
  const dueBefore = new Date(now.getTime() - TELEGRAM_RETRY_DELAY_SECONDS * 1000);
  const pending = await db.notification.findMany({
    where: { telegramStatus: 'PENDING', OR: [{ telegramLastAt: null }, { telegramLastAt: { lte: dueBefore } }] },
    select: { id: true, recipientId: true, priority: true, telegramAttempts: true, recipient: { select: { isActive: true, telegramChatId: true } } },
    orderBy: { id: 'asc' }, take: 500,
  });
  const byRecipient = new Map<number, typeof pending>();
  for (const n of pending) byRecipient.set(n.recipientId, [...(byRecipient.get(n.recipientId) ?? []), n]);

  const link = `${baseUrl.replace(/\/$/, '')}/notifications`;
  for (const [recipientId, rows] of byRecipient) {
    const ids = rows.map((r) => r.id);
    const chatId = rows[0]!.recipient.telegramChatId;
    // Unlinked or deactivated between the two statements.
    if (!chatId || !rows[0]!.recipient.isActive) {
      await db.notification.updateMany({ where: { id: { in: ids } }, data: { telegramStatus: 'SKIPPED' } });
      out.skipped += ids.length;
      continue;
    }
    out.recipients++;
    const sent = await telegram.send(chatId, announcement(rows.length, rows.some((r) => URGENT.has(r.priority)), link));
    if (sent.accepted) {
      await db.notification.updateMany({ where: { id: { in: ids } }, data: { telegramStatus: 'SENT', telegramAttempts: { increment: 1 }, telegramLastAt: new Date(), telegramMessageId: sent.messageId } });
      out.announced += ids.length;
      continue;
    }
    // Each row keeps its own count: a row that joined the batch later gets its full share of attempts.
    for (const r of rows) {
      const attempt = r.telegramAttempts + 1;
      const status: Notification['telegramStatus'] = attempt >= TELEGRAM_RETRY_MAX ? 'FAILED' : 'PENDING';
      await db.notification.update({ where: { id: r.id }, data: { telegramStatus: status, telegramAttempts: attempt, telegramLastAt: new Date() } });
      if (status === 'FAILED') out.failed++; else out.retrying++;
    }
    const level = rows.some((r) => r.telegramAttempts + 1 >= TELEGRAM_RETRY_MAX) ? 'error' : 'warn';
    logger[level](level === 'error' ? 'telegram delivery failed; giving up' : 'telegram delivery failed; will retry', { recipientId, chatId: maskChatId(chatId), notifications: ids.length });
  }
  return out;
}

/** Runs the dispatcher every `intervalMs` under the worker lease; returns a stop function. Runs never overlap. */
export function startTelegramDispatcher(db: Db, telegram: TelegramGateway, baseUrl: string, intervalMs = 60_000) {
  let running = false;
  const beat = async () => {
    if (running) return;
    running = true;
    try {
      const out = await withLease(db, 'telegram-dispatch', LEASE_SECONDS, () => dispatchTelegram(db, telegram, baseUrl));
      if (out.ran && (out.result.announced || out.result.failed || out.result.retrying)) logger.info('telegram dispatch', { ...out.result });
    } catch (e) {
      logger.error('telegram dispatch failed', describeError(e));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void beat(), intervalMs);
  void beat();
  logger.info('telegram dispatcher started', { driver: telegram.driver });
  return () => clearInterval(timer);
}
