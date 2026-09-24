// Password reset by role (decision D-50): self-service for staff accounts,
// HR-assisted for HR / Supervisor / System Admin accounts, never break-glass.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { makeNurse, makeOrg, makeUser, openDb, ORIGIN, PASSWORD, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const MAIL = { SMTP_HOST: '127.0.0.1', SMTP_FROM: 'AIGH Workforce <nurseapp@aigh.sa>', APP_BASE_URL: 'https://nurse.aigh.sa' };
const NEW = 'a-brand-new-password-26';

describeDb('password reset (D-50)', () => {
  let db: Db;
  let app: Express;
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let hr: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db, MAIL);
    org = await makeOrg(db);
    hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  const ask = (a: Express, email: string) => request(a).post('/api/v1/auth/password-reset/request').set('Origin', ORIGIN).send({ email });
  const complete = (a: Express, token: string, password = NEW) => request(a).post('/api/v1/auth/password-reset/complete').set('Origin', ORIGIN).send({ token, password });
  const login = (a: Express, email: string, password: string) => request(a).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password });
  /** The newest reset e-mail to this address, and its token (as the user receives it). */
  async function lastLink(email: string) {
    const mail = await db.emailOutbox.findFirst({ where: { toAddress: email, eventKey: { startsWith: 'password-reset:' } }, orderBy: { id: 'desc' } });
    if (!mail) return null;
    return { token: /https:\/\/nurse\.aigh\.sa\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(mail.bodyText)![1]!, mail };
  }
  const staff = async () => (await makeNurse(db, org.unitA.id, { account: true })).user!;

  it('a staff account resets itself: 202, a 30-minute link by e-mail, then the new password works and every session is signed out', async () => {
    const u = await staff();
    const session = await signIn(app, u.email);
    const res = await ask(app, u.email.toUpperCase());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    const link = await lastLink(u.email);
    expect(link!.mail).toMatchObject({ priority: 'HIGH', status: 'PENDING' });
    const row = await db.passwordReset.findFirstOrThrow({ where: { userId: u.id }, orderBy: { id: 'desc' } });
    expect(row).toMatchObject({ mode: 'SELF', requestedById: null });
    expect(row.tokenHash).not.toContain(link!.token);
    const minutes = (row.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);

    expect((await complete(app, link!.token)).status).toBe(204);
    expect((await login(app, u.email, PASSWORD)).status).toBe(401);
    expect((await login(app, u.email, NEW)).status).toBe(200);
    expect((await session.refresh()).status).toBe(401); // the old session was revoked
    expect((await complete(app, link!.token, 'yet-another-password-26')).body.error.code).toBe('PASSWORD_RESET_INVALID'); // single use
    expect(await db.auditEntry.count({ where: { action: 'PASSWORD_RESET_COMPLETED', resourceId: String(u.id) } })).toBe(1);
  });

  it('answers the same for unknown, privileged, break-glass and inactive addresses — and e-mails none of them', async () => {
    const privileged = await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
    const breakGlass = await makeUser(db, { isBreakGlass: true });
    const inactive = await makeUser(db, { isActive: false });
    for (const email of ['nobody@aigh.sa', privileged.email, breakGlass.email, inactive.email]) {
      const res = await ask(app, email);
      expect([res.status, res.body]).toEqual([202, { accepted: true }]);
      expect(await lastLink(email)).toBeNull();
    }
    expect(await db.auditEntry.count({ where: { action: 'PASSWORD_RESET_SELF_REFUSED', resourceId: String(privileged.id) } })).toBe(1);
    // With e-mail off nothing is sent either, and the answer is still the same.
    const u = await staff();
    expect((await ask(testApp(db), u.email)).status).toBe(202);
    expect(await lastLink(u.email)).toBeNull();
  });

  it('a newer link revokes the older one; an expired link fails; a staff link dies if the account is promoted', async () => {
    const u = await staff();
    await ask(app, u.email);
    const first = (await lastLink(u.email))!.token;
    await ask(app, u.email);
    const second = (await lastLink(u.email))!.token;
    expect((await complete(app, first)).body.error.code).toBe('PASSWORD_RESET_INVALID');

    await db.passwordReset.updateMany({ where: { userId: u.id, usedAt: null, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await complete(app, second)).body.error.code).toBe('PASSWORD_RESET_INVALID');

    await ask(app, u.email);
    const third = (await lastLink(u.email))!.token;
    await db.roleAssignment.create({ data: { userId: u.id, role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id], reason: 'promoted after the reset request', grantedById: u.id } });
    expect((await complete(app, third)).body.error.code).toBe('PASSWORD_RESET_INVALID');
    expect((await login(app, u.email, PASSWORD)).status).toBe(200); // unchanged
  });

  it('HR sends a 24-hour link to a privileged account; the link goes to that account, and the rules hold', async () => {
    const sup = await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] });
    const res = await hr.post(`/users/${sup.id}/password-reset`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ email: sup.email, expiresAt: expect.any(String) });
    const hours = (new Date(res.body.expiresAt).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(23.9);
    const link = (await lastLink(sup.email))!;
    expect(JSON.stringify(res.body)).not.toContain(link.token);
    expect(await db.passwordReset.findFirstOrThrow({ where: { userId: sup.id } })).toMatchObject({ mode: 'ASSISTED' });
    expect((await complete(app, link.token)).status).toBe(204);
    expect((await login(app, sup.email, NEW)).status).toBe(200);

    const hrUser = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const hrClient = await signIn(app, hrUser.email);
    expect((await hrClient.post(`/users/${hrUser.id}/password-reset`)).body.error.code).toBe('SELF_ACTION_FORBIDDEN');
    expect((await hrClient.post(`/users/${(await makeUser(db, { isBreakGlass: true })).id}/password-reset`)).body.error.code).toBe('BREAK_GLASS_ACCOUNT_PROTECTED');
    const outOfScope = (await makeNurse(db, org.unitC.id, { account: true })).user!;
    const unitHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    expect((await unitHr.post(`/users/${outOfScope.id}/password-reset`)).status).toBe(403);
    const supClient = await signIn(app, sup.email, NEW);
    expect((await supClient.post(`/users/${outOfScope.id}/password-reset`)).status).toBe(403);
    const hrNoMail = await signIn(testApp(db), (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hrNoMail.post(`/users/${outOfScope.id}/password-reset`)).body.error.code).toBe('EMAIL_OFF');
  });

  it('completing a reset clears a sign-in lockout', async () => {
    const limited = testApp(db, { ...MAIL, LOGIN_THROTTLE_MAX_PER_ACCOUNT: '2' });
    const u = await staff();
    for (let i = 0; i < 2; i++) await login(limited, u.email, 'wrong-password-123');
    expect((await login(limited, u.email, PASSWORD)).status).toBe(429);
    // The reset request itself counts against the same per-account limit, so HR sends it.
    await hr.post(`/users/${u.id}/password-reset`);
    expect((await complete(limited, (await lastLink(u.email))!.token)).status).toBe(204);
    expect((await login(limited, u.email, NEW)).status).toBe(200);
  });

  it('limits requests per address and per client, and requires the app origin', async () => {
    const limited = testApp(db, { ...MAIL, LOGIN_THROTTLE_MAX_PER_ACCOUNT: '2', LOGIN_THROTTLE_MAX_PER_CLIENT: '50' });
    const u = await staff();
    expect((await ask(limited, u.email)).status).toBe(202);
    expect((await ask(limited, u.email)).status).toBe(202);
    const third = await ask(limited, u.email);
    expect(third.status).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect((await ask(limited, 'someone.else@aigh.sa')).status).toBe(202); // per address
    const clientLimited = testApp(db, { ...MAIL, LOGIN_THROTTLE_MAX_PER_CLIENT: '2' });
    for (let i = 0; i < 2; i++) await complete(clientLimited, 'B'.repeat(43));
    expect((await complete(clientLimited, 'B'.repeat(43))).status).toBe(429);
    expect((await request(app).post('/api/v1/auth/password-reset/request').send({ email: u.email })).body.error.code).toBe('ORIGIN_REJECTED');
  });
});
