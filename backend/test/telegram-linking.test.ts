// Connecting accounts to Telegram (D-66): single-use deep links, /start and
// /stop, one chat per account and one account per chat, the HR link, the Dev
// Console simulator, and the webhook's secret.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import type { Db } from '../src/lib/prisma.js';
import { MockTelegramGateway } from '../src/lib/telegram.js';
import { fastPasswords, makeNurse, makeOrg, makeUser, openDb, ORIGIN, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

let n = 0;
const chat = () => String(6_000_000_000 + ((Date.now() * 10 + n++) % 1_000_000_000));
const SECRET = 'w'.repeat(40);

describe('webhook settings', () => {
  const base = { DATABASE_URL: 'postgresql://x@y/z', JWT_SECRET: 'x'.repeat(32), NOTIFICATION_DRIVER: 'telegram', TELEGRAM_BOT_TOKEN: '1:t', TELEGRAM_BOT_USERNAME: 'aigh_bot' };
  it('polling by default; the webhook needs a secret of at least 32 characters', () => {
    expect(loadEnv(base).TELEGRAM_UPDATES).toBe('polling');
    expect(() => loadEnv({ ...base, TELEGRAM_UPDATES: 'webhook', TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadEnv({ ...base, TELEGRAM_UPDATES: 'webhook', TELEGRAM_WEBHOOK_SECRET: 'bad chars!'.repeat(4) })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(loadEnv({ ...base, TELEGRAM_UPDATES: 'webhook', TELEGRAM_WEBHOOK_SECRET: SECRET }).TELEGRAM_UPDATES).toBe('webhook');
  });
});

describeDb('Telegram account linking (D-66)', () => {
  let db: Db;
  let app: ReturnType<typeof testApp>;
  let sa: Awaited<ReturnType<typeof signIn>>;
  beforeAll(async () => {
    db = openDb();
    app = testApp(db, { TELEGRAM_BOT_USERNAME: 'aigh_test_bot' });
    sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  /** What the bot would receive if `chatId` sent `text`. */
  const say = (chatId: string, text: string) => sa.post('/dev-console/telegram-inbox/simulate', { chatId, text });
  const lastReply = async (chatId: string) => (await db.mockTelegramOutbox.findFirstOrThrow({ where: { chatId }, orderBy: { id: 'desc' } })).messageText;

  it('a staff member links their own chat with a single-use deep link', async () => {
    const u = await makeUser(db);
    const me = await signIn(app, u.email);
    expect((await me.get('/me/telegram')).body).toMatchObject({ linked: false, botUsername: 'aigh_test_bot', driver: 'mock', available: true });

    const offer = await me.post('/me/telegram/link');
    expect(offer.status).toBe(201);
    expect(offer.body.startParameter).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(offer.body.url).toBe(`https://t.me/aigh_test_bot?start=${offer.body.startParameter}`);
    expect(JSON.stringify(await db.telegramLinkToken.findMany({ where: { userId: u.id } }))).not.toContain(offer.body.startParameter);

    const c = chat();
    expect((await say(c, `/start ${offer.body.startParameter}`)).status).toBe(201);
    expect(await lastReply(c)).toMatch(/now connected to your account/);
    expect((await me.get('/me/telegram')).body).toMatchObject({ linked: true, linkedAt: expect.any(String) });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).telegramChatId).toBe(c);
    expect(await db.auditEntry.findFirst({ where: { action: 'TELEGRAM_LINKED', resourceId: String(u.id) } })).toMatchObject({ priority: 'HIGH' });
    expect(await db.notification.count({ where: { recipientId: u.id, title: 'Telegram connected' } })).toBe(1);
    // The reply names nobody.
    expect(await lastReply(c)).not.toContain(u.email);

    // Single use.
    const other = chat();
    await say(other, `/start ${offer.body.startParameter}`);
    expect(await lastReply(other)).toMatch(/expired or was already used/);
  });

  it('an expired link, a replaced link and a group chat are refused', async () => {
    const u = await makeUser(db);
    const me = await signIn(app, u.email);
    const first = (await me.post('/me/telegram/link')).body.startParameter as string;
    const second = (await me.post('/me/telegram/link')).body.startParameter as string;
    const c = chat();
    await say(c, `/start ${first}`);
    expect(await lastReply(c)).toMatch(/expired or was already used/); // replaced by the second

    await db.telegramLinkToken.updateMany({ where: { userId: u.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await say(c, `/start ${second}`);
    expect(await lastReply(c)).toMatch(/expired or was already used/);

    const third = (await me.post('/me/telegram/link')).body.startParameter as string;
    await (createApp({ env: testEnv(), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':' }).locals.telegramLinking as { handleUpdate: (u: object) => Promise<void> })
      .handleUpdate({ update_id: 1, message: { chat: { id: -100123, type: 'group' }, text: `/start ${third}` } });
    expect(await lastReply('-100123')).toMatch(/private chat/);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).telegramChatId).toBeNull();
  });

  it('/stop and Disconnect unlink, audited; a chat moves to the account that links it last', async () => {
    const [a, b] = [await makeUser(db), await makeUser(db)];
    const [ma, mb] = [await signIn(app, a.email), await signIn(app, b.email)];
    const c = chat();
    await say(c, `/start ${(await ma.post('/me/telegram/link')).body.startParameter}`);
    await say(c, `/start ${(await mb.post('/me/telegram/link')).body.startParameter}`);
    expect((await db.user.findUniqueOrThrow({ where: { id: a.id } })).telegramChatId).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: b.id } })).telegramChatId).toBe(c);
    expect((await db.auditEntry.findFirstOrThrow({ where: { action: 'TELEGRAM_UNLINKED', resourceId: String(a.id) } })).changes).toMatchObject({ via: 'moved to another account' });

    await say(c, '/stop');
    expect(await lastReply(c)).toMatch(/no longer connected/);
    expect((await db.user.findUniqueOrThrow({ where: { id: b.id } })).telegramChatId).toBeNull();
    await say(c, '/stop');
    expect(await lastReply(c)).toMatch(/not connected to an account/);

    await say(c, `/start ${(await ma.post('/me/telegram/link')).body.startParameter}`);
    expect((await ma.del('/me/telegram')).status).toBe(204);
    expect((await ma.del('/me/telegram')).body.error.code).toBe('TELEGRAM_NOT_LINKED');
    expect(await db.auditEntry.count({ where: { action: 'TELEGRAM_UNLINKED', resourceId: String(a.id) } })).toBe(2);
  });

  it('/start without a link, and other commands, get help with the chat id; plain text gets no reply', async () => {
    const c = chat();
    await say(c, '/start');
    expect(await lastReply(c)).toContain(`This chat's id is ${c}`);
    const before = await db.mockTelegramOutbox.count({ where: { chatId: c } });
    await say(c, 'hello');
    expect(await db.mockTelegramOutbox.count({ where: { chatId: c } })).toBe(before);
  });

  it('HR creates a link for an account in scope, never for break-glass; the break-glass account cannot link itself', async () => {
    const org = await makeOrg(db);
    const nurse = await makeNurse(db, org.unitA.id, { account: true });
    const hrScoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitB.id] }] })).email);
    const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hrScoped.post(`/users/${nurse.user!.id}/telegram/link`)).status).toBe(403);
    const offer = await hr.post(`/users/${nurse.user!.id}/telegram/link`);
    expect(offer.status).toBe(201);
    const c = chat();
    await say(c, `/start ${offer.body.startParameter}`);
    expect((await db.user.findUniqueOrThrow({ where: { id: nurse.user!.id } })).telegramChatId).toBe(c);
    expect((await db.auditEntry.findFirstOrThrow({ where: { action: 'TELEGRAM_LINKED', resourceId: String(nurse.user!.id) } })).changes).toMatchObject({ issuedByAnother: true });

    const bg = await makeUser(db, { isBreakGlass: true, roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    expect((await hr.post(`/users/${bg.id}/telegram/link`)).body.error.code).toBe('BREAK_GLASS_ACCOUNT_PROTECTED');
    const bgSession = await signIn(app, bg.email);
    expect((await bgSession.post('/me/telegram/link')).body.error.code).toBe('BREAK_GLASS_ACCOUNT_PROTECTED');
    const listed = (await hr.get('/users?q=' + encodeURIComponent(nurse.user!.email))).body.items as { id: number; telegramLinked: boolean; telegramChatId?: string }[];
    const row = listed.find((x) => x.id === nurse.user!.id)!;
    expect(row.telegramLinked).toBe(true);
    expect(row.telegramChatId).toBeUndefined(); // whether, never the chat id
  });

  it('the simulator is for the mock driver only', async () => {
    const live = createApp({ env: testEnv({ NOTIFICATION_DRIVER: 'telegram', TELEGRAM_BOT_TOKEN: '1:t', TELEGRAM_BOT_USERNAME: 'aigh_bot' }), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':', telegram: new MockTelegramGateway(db) });
    const admin = await signIn(live, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    expect((await admin.post('/dev-console/telegram-inbox/simulate', { chatId: chat(), text: '/start' })).body.error.code).toBe('TELEGRAM_LIVE');
  });

  it('the webhook answers 404 unless on, 401 without the secret, and handles an update with it', async () => {
    const hook = (a: typeof app, secret?: string) => {
      const r = request(a).post('/api/v1/telegram/webhook').set('Origin', ORIGIN);
      return (secret ? r.set('X-Telegram-Bot-Api-Secret-Token', secret) : r);
    };
    expect((await hook(app).send({ update_id: 1 })).status).toBe(404);

    const live = createApp({
      env: testEnv({ NOTIFICATION_DRIVER: 'telegram', TELEGRAM_BOT_TOKEN: '1:t', TELEGRAM_BOT_USERNAME: 'aigh_bot', TELEGRAM_UPDATES: 'webhook', TELEGRAM_WEBHOOK_SECRET: SECRET }),
      db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':', telegram: new MockTelegramGateway(db),
    });
    expect((await hook(live).send({ update_id: 2 })).status).toBe(401);
    expect((await hook(live, 'x'.repeat(40)).send({ update_id: 2 })).status).toBe(401);
    const c = chat();
    const ok = await hook(live, SECRET).send({ update_id: 3, message: { chat: { id: Number(c), type: 'private' }, text: '/start' } });
    expect([ok.status, ok.body]).toEqual([200, { ok: true }]);
    expect(await lastReply(c)).toContain(`This chat's id is ${c}`);
    // A malformed update is still acknowledged, so Telegram does not re-send it.
    expect((await hook(live, SECRET).send({ nonsense: true })).status).toBe(200);
  });
});
