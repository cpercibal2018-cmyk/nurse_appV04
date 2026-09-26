// Telegram behind one gateway (D-66, replacing SMS): the settings, the driver
// binding, the Bot API call, the mock driver's outbox (and its database rules),
// the break-glass alert, the Dev Console inbox, and the 30-day purge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { MOCK_TELEGRAM_RETENTION_DAYS, mockTelegramPurge } from '../src/jobs/mock-telegram-purge.js';
import type { Db, DbClient } from '../src/lib/prisma.js';
import { BotApiTelegramGateway, createTelegramGateway, escapeMarkdown, maskChatId, MockTelegramGateway, type TelegramGateway } from '../src/lib/telegram.js';
import { fastPasswords, makeUser, openDb, ORIGIN, PASSWORD, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

/** A different, unused chat id on each call. */
let n = 0;
const chat = () => String(7_000_000_000 + ((Date.now() * 10 + n++) % 1_000_000_000));

const TOKEN = '123456:secret-token';
/** A fetch double: answers `reply` and records what was sent. */
function fakeFetch(reply: { status?: number; body?: unknown; throws?: Error }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply.throws) throw reply.throws;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('Telegram settings and the driver binding', () => {
  const base = { DATABASE_URL: 'postgresql://x@y/z', JWT_SECRET: 'x'.repeat(32) };

  it('defaults to the mock driver; the live driver needs the bot token and username', () => {
    expect(loadEnv(base).NOTIFICATION_DRIVER).toBe('mock');
    expect(() => loadEnv({ ...base, NOTIFICATION_DRIVER: 'telegram' })).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => loadEnv({ ...base, NOTIFICATION_DRIVER: 'sms' })).toThrow(/NOTIFICATION_DRIVER/);
    const env = loadEnv({ ...base, NOTIFICATION_DRIVER: 'telegram', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: '@aigh_nursing_bot' });
    expect(env.TELEGRAM_BOT_USERNAME).toBe('aigh_nursing_bot');
    expect(() => loadEnv({ ...base, TELEGRAM_BOT_USERNAME: 'not a name' })).toThrow(/TELEGRAM_BOT_USERNAME/);
  });

  it('reads the break-glass chat ids', () => {
    expect(loadEnv({ ...base, BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS: ' 123456789, -1001234567890 ' }).BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS).toEqual(['123456789', '-1001234567890']);
    expect(() => loadEnv({ ...base, BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS: '+966501234567' })).toThrow(/BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS/);
  });

  it('binds MockTelegramGateway for mock and BotApiTelegramGateway for telegram', () => {
    const db = {} as DbClient;
    expect(createTelegramGateway({ NOTIFICATION_DRIVER: 'mock', TELEGRAM_BOT_TOKEN: '' }, db)).toBeInstanceOf(MockTelegramGateway);
    expect(createTelegramGateway({ NOTIFICATION_DRIVER: 'telegram', TELEGRAM_BOT_TOKEN: TOKEN }, db)).toBeInstanceOf(BotApiTelegramGateway);
  });

  it('escapes MarkdownV2 and masks chat ids', () => {
    expect(escapeMarkdown('Ward 3-B (night).')).toBe('Ward 3\\-B \\(night\\)\\.');
    expect(maskChatId('123456789')).toBe('…6789');
  });
});

describe('the Bot API driver', () => {
  it('posts sendMessage and answers the message id', async () => {
    const f = fakeFetch({ body: { ok: true, result: { message_id: 42 } } });
    const out = await new BotApiTelegramGateway(TOKEN, f.impl).send(' 123456789 ', '  Hello  ', { markdown: true });
    expect(out).toEqual({ accepted: true, messageId: '42' });
    expect(f.calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(f.calls[0]!.body).toMatchObject({ chat_id: '123456789', text: 'Hello', parse_mode: 'MarkdownV2' });
  });

  it('never throws: a refusal, an outage and a bad chat id answer not accepted, without calling for the bad id', async () => {
    const refused = fakeFetch({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
    expect(await new BotApiTelegramGateway(TOKEN, refused.impl).send('123456789', 'hi')).toEqual({ accepted: false, messageId: null });
    const down = fakeFetch({ throws: new TypeError('fetch failed') });
    expect((await new BotApiTelegramGateway(TOKEN, down.impl).send('123456789', 'hi')).accepted).toBe(false);
    const unused = fakeFetch({ body: { ok: true, result: { message_id: 1 } } });
    expect((await new BotApiTelegramGateway(TOKEN, unused.impl).send('+966501234567', 'hi')).accepted).toBe(false);
    expect((await new BotApiTelegramGateway(TOKEN, unused.impl).send('123456789', 'x'.repeat(4097))).accepted).toBe(false);
    expect(unused.calls).toHaveLength(0);
  });

  it('a failing mock outbox answers not accepted', async () => {
    const broken = { mockTelegramOutbox: { create: async () => { throw new Error('connection lost'); } } } as unknown as DbClient;
    expect((await new MockTelegramGateway(broken).send('123456789', 'hello')).accepted).toBe(false);
  });
});

describeDb('Telegram through the mock gateway (D-66)', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });

  it('keeps each message in mock_telegram_outbox as intercepted, and refuses a bad chat id or text', async () => {
    const tg = new MockTelegramGateway(db);
    const to = chat();
    const out = await tg.send(to, '  Shift reminder  ', { markdown: true });
    expect(out.accepted).toBe(true);
    const row = await db.mockTelegramOutbox.findFirstOrThrow({ where: { chatId: to } });
    expect(row).toMatchObject({ messageText: 'Shift reminder', parseMode: 'MarkdownV2', status: 'intercepted' });
    expect(out.messageId).toBe(String(row.id));

    expect((await tg.send('abc', 'hello')).accepted).toBe(false);
    expect((await tg.send(to, '   ')).accepted).toBe(false);
    expect(await db.mockTelegramOutbox.count({ where: { chatId: to } })).toBe(1);
  });

  it('the database keeps the same rules', async () => {
    await expect(db.mockTelegramOutbox.create({ data: { chatId: '+966501234567', messageText: 'x' } })).rejects.toThrow(/mock_telegram_outbox_chat_id/);
    await expect(db.mockTelegramOutbox.create({ data: { chatId: chat(), messageText: '' } })).rejects.toThrow(/mock_telegram_outbox_text_length/);
    await expect(db.mockTelegramOutbox.create({ data: { chatId: chat(), messageText: 'x', parseMode: 'HTML' } })).rejects.toThrow(/mock_telegram_outbox_parse_mode/);
    await expect(db.mockTelegramOutbox.create({ data: { chatId: chat(), messageText: 'x', status: 'sent' } })).rejects.toThrow(/mock_telegram_outbox_status/);
  });

  it('break-glass sign-in messages the CEO and IT Director, without the client address; audited (spec §3.6)', async () => {
    const [ceo, it] = [chat(), chat()];
    const app = testApp(db, { BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS: `${ceo},${it}` });
    const bg = await makeUser(db, { isBreakGlass: true, roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    const login = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: bg.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const rows = await db.mockTelegramOutbox.findMany({ where: { chatId: { in: [ceo, it] } } });
    expect(rows.map((r) => r.chatId).sort()).toEqual([ceo, it].sort());
    expect(rows[0]!.messageText).toMatch(/break-glass \(emergency\) account signed in at .+ UTC\. The session ends .+ UTC/);
    expect(rows[0]!.messageText).not.toMatch(/\d+\.\d+\.\d+\.\d+|::/);
    expect(await db.auditEntry.findFirst({ where: { action: 'BREAK_GLASS_TELEGRAM_SENT', resourceId: String(bg.id) } })).toMatchObject({ priority: 'HIGH' });
  });

  it('a failing gateway never blocks break-glass access; the failure is audited', async () => {
    const failing: TelegramGateway = { driver: 'telegram', send: async () => ({ accepted: false, messageId: null }) };
    const app = createApp({ env: testEnv({ BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS: chat() }), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':', telegram: failing });
    const bg = await makeUser(db, { isBreakGlass: true, roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    expect((await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: bg.email, password: PASSWORD })).status).toBe(200);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'BREAK_GLASS_TELEGRAM_FAILED', resourceId: String(bg.id) } });
    expect(audit.changes).toMatchObject({ driver: 'telegram', sent: 0, failed: 1 });
  });

  it('the Dev Console lists the inbox newest first and sends a test message (System Admin, elevated)', async () => {
    const app = testApp(db);
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const to = chat();
    const sent = await sa.post('/dev-console/telegram-inbox/test', { chatId: to, message: 'Demo: a new notification is waiting' });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ accepted: true, driver: 'mock', messageId: expect.any(String) });
    await new MockTelegramGateway(db).send(to, 'Second, newer message');

    const inbox = await sa.get('/dev-console/telegram-inbox?limit=2');
    expect(inbox.status).toBe(200);
    expect(inbox.body.driver).toBe('mock');
    expect(inbox.body.items.map((i: { messageText: string }) => i.messageText)).toEqual(['Second, newer message', 'Demo: a new notification is waiting']);
    expect(inbox.body.total).toBeGreaterThanOrEqual(2);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'TELEGRAM_TEST_SENT' }, orderBy: { id: 'desc' } });
    expect(audit.changes).toMatchObject({ driver: 'mock', chatId: maskChatId(to), accepted: true });

    expect((await sa.post('/dev-console/telegram-inbox/test', { chatId: '+966501234567', message: 'x' })).body.error.code).toBe('VALIDATION_FAILED');
    const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hr.get('/dev-console/telegram-inbox')).status).toBe(403);
  });

  it('a test message the gateway refuses answers 502 and is still audited', async () => {
    const app = createApp({ env: testEnv(), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':', telegram: { driver: 'telegram', send: async () => ({ accepted: false, messageId: null }) } });
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const res = await sa.post('/dev-console/telegram-inbox/test', { chatId: chat(), message: 'hello' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('TELEGRAM_NOT_ACCEPTED');
    expect((await db.auditEntry.findFirstOrThrow({ where: { action: 'TELEGRAM_TEST_SENT' }, orderBy: { id: 'desc' } })).changes).toMatchObject({ accepted: false });
  });

  it(`purges messages older than ${MOCK_TELEGRAM_RETENTION_DAYS} days`, async () => {
    const [oldTo, newTo] = [chat(), chat()];
    const now = new Date();
    await db.mockTelegramOutbox.create({ data: { chatId: oldTo, messageText: 'old', createdAt: new Date(now.getTime() - (MOCK_TELEGRAM_RETENTION_DAYS + 1) * 86_400_000) } });
    await db.mockTelegramOutbox.create({ data: { chatId: newTo, messageText: 'new' } });
    const out = await mockTelegramPurge(db, now);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(await db.mockTelegramOutbox.count({ where: { chatId: oldTo } })).toBe(0);
    expect(await db.mockTelegramOutbox.count({ where: { chatId: newTo } })).toBe(1);
  });
});
