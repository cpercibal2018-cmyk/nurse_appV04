// Notifications announced by Telegram (D-66): one message per recipient per
// run, no content from the notification, skipped without a linked chat,
// retried then FAILED, and reported in business health.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announcement, dispatchTelegram, TELEGRAM_RETRY_DELAY_SECONDS, TELEGRAM_RETRY_MAX } from '../src/jobs/telegram-dispatch.js';
import { businessHealth } from '../src/modules/audit/business-health.js';
import type { Db } from '../src/lib/prisma.js';
import type { TelegramGateway } from '../src/lib/telegram.js';
import { makeUser, openDb, TEST_URL, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
let n = 0;
const chat = () => String(5_000_000_000 + ((Date.now() * 10 + n++) % 1_000_000_000));
const BASE = 'https://nurse.example.sa';

/** A gateway double that records what it was asked to send. */
function recording(accept = true) {
  const sent: { chatId: string; text: string }[] = [];
  let id = 100;
  const gw: TelegramGateway = { driver: 'telegram', send: async (chatId, text) => { sent.push({ chatId, text }); return accept ? { accepted: true, messageId: String(id++) } : { accepted: false, messageId: null }; } };
  return { gw, sent };
}

describe('the announcement', () => {
  it('says how many and whether urgent, with the link, in English and Arabic', () => {
    expect(announcement(1, false, `${BASE}/notifications`)).toMatch(/^AIGH Nursing Workforce: you have a new notification\. Sign in to read it: https:\/\/nurse\.example\.sa\/notifications\n\n.*إشعار جديد/s);
    expect(announcement(3, true, 'x')).toContain('3 new notifications (urgent)');
  });
});

describeDb('Telegram dispatcher (D-66)', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });

  const notify = (recipientId: number, priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM') => db.notification.create({
    data: { recipientId, type: 'SECURITY', priority, title: `Licence of Nurse ${uniq('X')} expires`, message: 'Personal detail that must never reach Telegram', eventKey: uniq('tg') },
  });
  const linked = async () => {
    const u = await makeUser(db);
    return db.user.update({ where: { id: u.id }, data: { telegramChatId: chat(), telegramLinkedAt: new Date() } });
  };

  it('one message per recipient announces all its pending notifications; nothing from them is sent', async () => {
    const u = await linked();
    const [a, b] = [await notify(u.id), await notify(u.id, 'HIGH')];
    const { gw, sent } = recording();
    await dispatchTelegram(db, gw, BASE);
    const mine = sent.filter((s) => s.chatId === u.telegramChatId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain('2 new notifications (urgent)');
    expect(mine[0]!.text).not.toMatch(/Licence|Nurse|Personal detail/);
    const rows = await db.notification.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.map((r) => r.telegramStatus)).toEqual(['SENT', 'SENT']);
    expect(new Set(rows.map((r) => r.telegramMessageId)).size).toBe(1);
    // Sent once: the next run sends nothing more to this chat.
    const again = recording();
    await dispatchTelegram(db, again.gw, BASE);
    expect(again.sent.filter((s) => s.chatId === u.telegramChatId)).toHaveLength(0);
  });

  it('skips recipients without a linked chat, and inactive ones', async () => {
    const plain = await makeUser(db);
    const gone = await linked();
    await db.user.update({ where: { id: gone.id }, data: { isActive: false } });
    const [x, y] = [await notify(plain.id), await notify(gone.id)];
    const { gw, sent } = recording();
    await dispatchTelegram(db, gw, BASE);
    expect(sent.filter((s) => s.chatId === gone.telegramChatId)).toHaveLength(0);
    expect((await db.notification.findMany({ where: { id: { in: [x.id, y.id] } } })).map((r) => r.telegramStatus)).toEqual(['SKIPPED', 'SKIPPED']);
  });

  it(`a message not accepted is retried ${TELEGRAM_RETRY_DELAY_SECONDS} s apart, then FAILED and reported`, async () => {
    const u = await linked();
    const row = await notify(u.id);
    const { gw } = recording(false);
    let now = Date.now();
    await dispatchTelegram(db, gw, BASE, new Date(now));
    expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ telegramStatus: 'PENDING', telegramAttempts: 1 });
    // Not due yet: a run right away does not try again.
    await dispatchTelegram(db, gw, BASE, new Date(now + 1000));
    expect((await db.notification.findUniqueOrThrow({ where: { id: row.id } })).telegramAttempts).toBe(1);
    for (let i = 2; i <= TELEGRAM_RETRY_MAX; i++) {
      await db.notification.update({ where: { id: row.id }, data: { telegramLastAt: new Date(now - TELEGRAM_RETRY_DELAY_SECONDS * 1000 - 1) } });
      now += 1;
      await dispatchTelegram(db, gw, BASE, new Date(now));
    }
    expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ telegramStatus: 'FAILED', telegramAttempts: TELEGRAM_RETRY_MAX });
    const health = await businessHealth(db);
    expect(health.issues.map((i) => i.code)).toContain('TELEGRAM_FAILED');
    expect(health.telegram.linkedAccounts).toBeGreaterThanOrEqual(1);
  });
});
