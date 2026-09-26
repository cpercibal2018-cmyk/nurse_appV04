// Changing an account's sign-in e-mail (D-67): never instant. SELF needs the
// current password; ASSISTED is HR for an account in scope; both apply only
// from the link sent to the NEW address, warn the OLD one, re-check that the
// address is free, and sign every session out.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Db } from '../src/lib/prisma.js';
import { maskEmail } from '../src/modules/users/email-change.js';
import { makeNurse, makeOrg, makeUser, openDb, ORIGIN, PASSWORD, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const MAIL = { SMTP_HOST: '127.0.0.1', SMTP_FROM: 'AIGH Workforce <nurseapp@aigh.sa>', APP_BASE_URL: 'https://nurse.aigh.sa' };
const fresh = () => `${uniq('new')}@example.sa`.toLowerCase();

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => expect(maskEmail('nurse.one@aigh.sa')).toBe('n•••@aigh.sa'));
});

describeDb('sign-in e-mail change (D-67)', () => {
  let db: Db;
  let app: ReturnType<typeof testApp>;
  beforeAll(() => { db = openDb(); app = testApp(db, MAIL); });
  afterAll(async () => { await db.$disconnect(); });

  const confirm = (token: string, a = app) => request(a).post('/api/v1/auth/email-change/confirm').set('Origin', ORIGIN).send({ token });
  async function linkFor(newEmail: string) {
    const mail = await db.emailOutbox.findFirstOrThrow({ where: { toAddress: newEmail, eventKey: { endsWith: ':confirm' } }, orderBy: { id: 'desc' } });
    return /https:\/\/nurse\.aigh\.sa\/confirm-email#token=([A-Za-z0-9_-]{43})/.exec(mail.bodyText)![1]!;
  }

  it('SELF: the current password, then the link to the new address; the old one is warned; confirming switches and signs out', async () => {
    const u = await makeUser(db);
    const me = await signIn(app, u.email);
    const to = fresh();

    expect((await me.post('/me/email', { newEmail: to, currentPassword: 'wrong-password-123' })).body.error.code).toBe('CURRENT_PASSWORD_WRONG');
    const req = await me.post('/me/email', { newEmail: ` ${to.toUpperCase()} `, currentPassword: PASSWORD });
    expect(req.status).toBe(202);
    expect(req.body).toMatchObject({ pendingEmail: to, expiresAt: expect.any(String) });
    // Nothing changes yet.
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(u.email);
    expect((await me.get('/me/email')).body).toMatchObject({ email: u.email, pending: { newEmail: to, mode: 'SELF' } });
    const warn = await db.emailOutbox.findFirstOrThrow({ where: { toAddress: u.email, eventKey: { endsWith: ':warn' } }, orderBy: { id: 'desc' } });
    expect(warn.bodyText).toContain(maskEmail(to));
    expect(warn.bodyText).not.toContain(to);

    const token = await linkFor(to);
    const ok = await confirm(token);
    expect([ok.status, ok.body]).toEqual([200, { email: to }]);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBe(to);
    expect(await db.refreshSession.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
    expect((await me.refresh()).status).toBe(401); // signed out everywhere
    expect(await db.emailOutbox.count({ where: { toAddress: u.email, eventKey: { endsWith: ':done' } } })).toBe(1);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'EMAIL_CHANGED', resourceId: String(u.id) } });
    expect(audit).toMatchObject({ priority: 'HIGH', changes: { mode: 'SELF', from: maskEmail(u.email), to: maskEmail(to) } });

    // Single use; the new address signs in, the old one no longer does.
    expect((await confirm(token)).body.error.code).toBe('EMAIL_CHANGE_INVALID');
    expect((await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: to, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: PASSWORD })).status).toBe(401);
  });

  it('refuses a taken address, the same address, and e-mail off; a new request replaces the open one', async () => {
    const [u, other] = [await makeUser(db), await makeUser(db)];
    const me = await signIn(app, u.email);
    expect((await me.post('/me/email', { newEmail: other.email.toUpperCase(), currentPassword: PASSWORD })).body.error.code).toBe('EMAIL_IN_USE');
    expect((await me.post('/me/email', { newEmail: u.email, currentPassword: PASSWORD })).body.error.code).toBe('EMAIL_UNCHANGED');
    expect((await me.post('/me/email', { newEmail: 'not-an-email', currentPassword: PASSWORD })).body.error.code).toBe('VALIDATION_FAILED');

    const [first, second] = [fresh(), fresh()];
    await me.post('/me/email', { newEmail: first, currentPassword: PASSWORD });
    const firstToken = await linkFor(first);
    await me.post('/me/email', { newEmail: second, currentPassword: PASSWORD });
    expect((await confirm(firstToken)).body.error.code).toBe('EMAIL_CHANGE_INVALID');
    expect((await me.del('/me/email')).status).toBe(204);
    expect((await me.get('/me/email')).body.pending).toBeNull();
    expect((await me.del('/me/email')).body.error.code).toBe('EMAIL_CHANGE_NONE');

    const off = testApp(db);
    const meOff = await signIn(off, u.email);
    expect((await meOff.post('/me/email', { newEmail: fresh(), currentPassword: PASSWORD })).body.error.code).toBe('EMAIL_OFF');
  });

  it('the address is re-checked at confirmation, and an expired link is refused', async () => {
    const [a, b] = [await makeUser(db), await makeUser(db)];
    const target = fresh();
    await (await signIn(app, a.email)).post('/me/email', { newEmail: target, currentPassword: PASSWORD });
    const tokenA = await linkFor(target);
    await (await signIn(app, b.email)).post('/me/email', { newEmail: target, currentPassword: PASSWORD });
    const tokenB = await linkFor(target);
    expect((await confirm(tokenB)).status).toBe(200);
    expect((await confirm(tokenA)).body.error.code).toBe('EMAIL_IN_USE');

    const c = await makeUser(db);
    const late = fresh();
    await (await signIn(app, c.email)).post('/me/email', { newEmail: late, currentPassword: PASSWORD });
    await db.emailChange.updateMany({ where: { userId: c.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await confirm(await linkFor(late))).body.error.code).toBe('EMAIL_CHANGE_INVALID');
  });

  it('ASSISTED: HR for an account in scope, not its own and never break-glass; break-glass cannot change its own', async () => {
    const org = await makeOrg(db);
    const nurse = await makeNurse(db, org.unitA.id, { account: true });
    const hrScoped = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitB.id] }] })).email);
    const hrUser = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const hr = await signIn(app, hrUser.email);
    const to = fresh();
    expect((await hrScoped.post(`/users/${nurse.user!.id}/email`, { newEmail: to })).status).toBe(403);
    const res = await hr.post(`/users/${nurse.user!.id}/email`, { newEmail: to });
    expect(res.status).toBe(202);
    expect((await confirm(await linkFor(to))).status).toBe(200);
    expect((await db.auditEntry.findFirstOrThrow({ where: { action: 'EMAIL_CHANGED', resourceId: String(nurse.user!.id) } })).changes).toMatchObject({ mode: 'ASSISTED', requestedById: hrUser.id });

    expect((await hr.post(`/users/${hrUser.id}/email`, { newEmail: fresh() })).body.error.code).toBe('SELF_ACTION_FORBIDDEN');
    const bg = await makeUser(db, { isBreakGlass: true, roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    expect((await hr.post(`/users/${bg.id}/email`, { newEmail: fresh() })).body.error.code).toBe('BREAK_GLASS_ACCOUNT_PROTECTED');
    expect((await (await signIn(app, bg.email)).post('/me/email', { newEmail: fresh(), currentPassword: PASSWORD })).body.error.code).toBe('BREAK_GLASS_ACCOUNT_PROTECTED');
  });

  it('the confirm endpoint needs the app Origin', async () => {
    expect((await request(app).post('/api/v1/auth/email-change/confirm').set('Origin', 'https://evil.example').send({ token: 'x'.repeat(43) })).body.error.code).toBe('ORIGIN_REJECTED');
  });
});
