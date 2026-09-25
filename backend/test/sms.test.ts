// SMS behind one gateway (D-48, D-59): the settings, the driver binding, the mock
// driver's outbox (and its database rules), the break-glass text, the Dev Console
// inbox, and the 30-day purge.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { MOCK_SMS_RETENTION_DAYS, mockSmsPurge } from '../src/jobs/mock-sms-purge.js';
import type { Db, DbClient } from '../src/lib/prisma.js';
import { createSmsGateway, maskPhone, MockSmsGateway, UnifonicSmsGateway, type SmsGateway } from '../src/lib/sms.js';
import { fastPasswords, makeUser, openDb, ORIGIN, PASSWORD, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

/** A different, unused Saudi mobile number on each call. */
let n = 0;
const phone = () => `+9665${String((Date.now() + n++) % 100_000_000).padStart(8, '0')}`;

describe('SMS settings and the driver binding', () => {
  const base = { DATABASE_URL: 'postgresql://x@y/z', JWT_SECRET: 'x'.repeat(32) };

  it('defaults to the mock driver; the live driver needs its App SID and Sender ID', () => {
    expect(loadEnv(base).SMS_DRIVER).toBe('mock');
    expect(() => loadEnv({ ...base, SMS_DRIVER: 'unifonic' })).toThrow(/UNIFONIC_APP_SID/);
    expect(() => loadEnv({ ...base, SMS_DRIVER: 'twilio' })).toThrow(/SMS_DRIVER/);
    expect(loadEnv({ ...base, SMS_DRIVER: 'unifonic', UNIFONIC_APP_SID: 'sid', UNIFONIC_SENDER_ID: 'AIGH' }).SMS_DRIVER).toBe('unifonic');
  });

  it('reads the break-glass phones in international format', () => {
    expect(loadEnv({ ...base, BREAK_GLASS_ALERT_PHONES: '+966 50 123 4567, +966-55-765-4321' }).BREAK_GLASS_ALERT_PHONES).toEqual(['+966501234567', '+966557654321']);
    expect(() => loadEnv({ ...base, BREAK_GLASS_ALERT_PHONES: '0501234567' })).toThrow(/BREAK_GLASS_ALERT_PHONES/);
  });

  it('binds MockSmsGateway for mock and UnifonicSmsGateway otherwise', () => {
    const db = {} as DbClient;
    expect(createSmsGateway({ SMS_DRIVER: 'mock', UNIFONIC_APP_SID: '', UNIFONIC_SENDER_ID: '' }, db)).toBeInstanceOf(MockSmsGateway);
    expect(createSmsGateway({ SMS_DRIVER: 'unifonic', UNIFONIC_APP_SID: 'sid', UNIFONIC_SENDER_ID: 'AIGH' }, db)).toBeInstanceOf(UnifonicSmsGateway);
  });

  it('never throws: the live stub and a failing outbox answer false', async () => {
    expect(await new UnifonicSmsGateway({ appSid: 'sid', senderId: 'AIGH' }).send('+966501234567', 'hello')).toBe(false);
    const broken = { mockSmsOutbox: { create: async () => { throw new Error('connection lost'); } } } as unknown as DbClient;
    expect(await new MockSmsGateway(broken).send('+966501234567', 'hello')).toBe(false);
    expect(maskPhone('+966501234567')).toBe('+966…4567');
  });
});

describeDb('SMS through the mock gateway (D-59)', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });

  it('keeps each text in mock_sms_outbox as intercepted, and refuses a bad number or text', async () => {
    const sms = new MockSmsGateway(db);
    const to = phone();
    expect(await sms.send(to.replace(/(\d{3})(\d{3})$/, ' $1-$2'), '  Shift reminder  ')).toBe(true);
    const row = await db.mockSmsOutbox.findFirstOrThrow({ where: { recipientPhone: to } });
    expect(row).toMatchObject({ messageBody: 'Shift reminder', status: 'intercepted' });
    expect(row.createdAt).toBeInstanceOf(Date);

    expect(await sms.send('0501234567', 'hello')).toBe(false);
    expect(await sms.send(to, '   ')).toBe(false);
    expect(await sms.send(to, 'x'.repeat(1601))).toBe(false);
    expect(await db.mockSmsOutbox.count({ where: { recipientPhone: to } })).toBe(1);
  });

  it('the database keeps the same rules', async () => {
    await expect(db.mockSmsOutbox.create({ data: { recipientPhone: '0501234567', messageBody: 'x' } })).rejects.toThrow(/mock_sms_outbox_phone_e164/);
    await expect(db.mockSmsOutbox.create({ data: { recipientPhone: phone(), messageBody: '' } })).rejects.toThrow(/mock_sms_outbox_body_length/);
    await expect(db.mockSmsOutbox.create({ data: { recipientPhone: phone(), messageBody: 'x', status: 'sent' } })).rejects.toThrow(/mock_sms_outbox_status/);
  });

  it('break-glass sign-in texts the CEO and IT Director; the outcome is audited (spec §3.6)', async () => {
    const [ceo, it] = [phone(), phone()];
    const app = testApp(db, { BREAK_GLASS_ALERT_PHONES: `${ceo},${it}` });
    const bg = await makeUser(db, { isBreakGlass: true, roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    const login = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: bg.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const rows = await db.mockSmsOutbox.findMany({ where: { recipientPhone: { in: [ceo, it] } } });
    expect(rows.map((r) => r.recipientPhone).sort()).toEqual([ceo, it].sort());
    expect(rows[0]!.messageBody).toMatch(/break-glass \(emergency\) account signed in from .+ UTC\. The session ends .+ UTC/);
    expect(await db.auditEntry.findFirst({ where: { action: 'BREAK_GLASS_SMS_SENT', resourceId: String(bg.id) } })).toMatchObject({ priority: 'HIGH' });
  });

  it('a failing gateway never blocks break-glass access; the failure is audited', async () => {
    const failing: SmsGateway = { driver: 'unifonic', send: async () => false };
    const app = createApp({ env: testEnv({ BREAK_GLASS_ALERT_PHONES: phone() }), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':', sms: failing });
    const bg = await makeUser(db, { isBreakGlass: true, roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    expect((await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: bg.email, password: PASSWORD })).status).toBe(200);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'BREAK_GLASS_SMS_FAILED', resourceId: String(bg.id) } });
    expect(audit.changes).toMatchObject({ driver: 'unifonic', sent: 0, failed: 1 });
  });

  it('the Dev Console lists the inbox newest first and sends a test text (System Admin, elevated)', async () => {
    const app = testApp(db);
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const to = phone();
    const sent = await sa.post('/dev-console/sms-inbox/test', { phone: to, message: 'Demo: your shift starts at 07:00' });
    expect(sent.status).toBe(201);
    expect(sent.body).toEqual({ accepted: true, driver: 'mock' });
    await new MockSmsGateway(db).send(to, 'Second, newer text');

    const inbox = await sa.get('/dev-console/sms-inbox?limit=2');
    expect(inbox.status).toBe(200);
    expect(inbox.body.driver).toBe('mock');
    expect(inbox.body.items.map((i: { messageBody: string }) => i.messageBody)).toEqual(['Second, newer text', 'Demo: your shift starts at 07:00']);
    expect(inbox.body.total).toBeGreaterThanOrEqual(2);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'SMS_TEST_SENT' }, orderBy: { id: 'desc' } });
    expect(audit.changes).toMatchObject({ driver: 'mock', phone: maskPhone(to), accepted: true });

    expect((await sa.post('/dev-console/sms-inbox/test', { phone: '0501234567', message: 'x' })).body.error.code).toBe('VALIDATION_FAILED');
    const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hr.get('/dev-console/sms-inbox')).status).toBe(403);
  });

  it('a test text the gateway refuses answers 502 and is still audited', async () => {
    const app = createApp({ env: testEnv(), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':', sms: { driver: 'unifonic', send: async () => false } });
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const res = await sa.post('/dev-console/sms-inbox/test', { phone: phone(), message: 'hello' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SMS_NOT_ACCEPTED');
    expect((await db.auditEntry.findFirstOrThrow({ where: { action: 'SMS_TEST_SENT' }, orderBy: { id: 'desc' } })).changes).toMatchObject({ accepted: false });
  });

  it(`purges texts older than ${MOCK_SMS_RETENTION_DAYS} days`, async () => {
    const [oldTo, newTo] = [phone(), phone()];
    const now = new Date();
    await db.mockSmsOutbox.create({ data: { recipientPhone: oldTo, messageBody: 'old', createdAt: new Date(now.getTime() - (MOCK_SMS_RETENTION_DAYS + 1) * 86_400_000) } });
    await db.mockSmsOutbox.create({ data: { recipientPhone: newTo, messageBody: 'new' } });
    const out = await mockSmsPurge(db, now);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(await db.mockSmsOutbox.count({ where: { recipientPhone: oldTo } })).toBe(0);
    expect(await db.mockSmsOutbox.count({ where: { recipientPhone: newTo } })).toBe(1);
  });
});
