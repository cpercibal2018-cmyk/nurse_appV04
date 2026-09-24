// Registration by invitation (spec §3.2): HR issues, the link is e-mailed only,
// the employee previews with the Job Number and claims one self-service account.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { makeEmployee, makeNurse, makeOrg, makeUser, openDb, ORIGIN, signIn, TEST_URL, testApp, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const MAIL = { SMTP_HOST: '127.0.0.1', SMTP_FROM: 'AIGH Workforce <nurseapp@aigh.sa>', APP_BASE_URL: 'https://nurse.aigh.sa' };
const NEW_PASSWORD = 'my-own-strong-pass-2026';

describeDb('registration by invitation (spec §3.2)', () => {
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

  const pub = (a: Express, path: string, body: object) => request(a).post(`/api/v1/auth/invitations/${path}`).set('Origin', ORIGIN).send(body);
  /** An invitable nurse (active contract today) with a unique contact e-mail. */
  async function invitable() {
    const { emp } = await makeNurse(db, org.unitA.id);
    const email = `${uniq('inv')}@staff.aigh.sa`;
    await db.employee.update({ where: { id: emp.id }, data: { contactEmail: email.toUpperCase() } }); // stored as typed; invited lower-case
    return { emp, email };
  }
  /** The token as the employee receives it: from the e-mailed link. */
  async function tokenFromMail(invitationId: number) {
    const mail = await db.emailOutbox.findFirstOrThrow({ where: { eventKey: `invitation:${invitationId}` } });
    const m = /https:\/\/nurse\.aigh\.sa\/claim#token=([A-Za-z0-9_-]{43})/.exec(mail.bodyText);
    expect(mail.bodyHtml).toContain(m![1]);
    return { token: m![1]!, mail };
  }

  it('HR issues an invitation: the link is e-mailed to the contact address and never returned', async () => {
    const { emp, email } = await invitable();
    const res = await hr.post(`/employees/${emp.id}/invitations`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(Number), email, expiresAt: expect.any(String) });
    const hours = (new Date(res.body.expiresAt).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    const { token, mail } = await tokenFromMail(res.body.id);
    expect(mail).toMatchObject({ toAddress: email, priority: 'HIGH', status: 'PENDING' });
    expect(JSON.stringify(res.body)).not.toContain(token);
    const row = await db.invitation.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify((await hr.get(`/employees/${emp.id}/invitations`)).body)).not.toContain(token);
    expect(await db.auditEntry.count({ where: { action: 'INVITATION_ISSUED', resourceId: String(emp.id) } })).toBe(1);
  });

  it('refuses employees that are not eligible, callers out of scope, and a system without e-mail', async () => {
    const withAccount = await makeNurse(db, org.unitA.id, { account: true });
    expect((await hr.post(`/employees/${withAccount.emp.id}/invitations`)).body.error.code).toBe('EMPLOYEE_HAS_ACCOUNT');
    const noContract = await makeEmployee(db, org.unitA.id);
    await db.employee.update({ where: { id: noContract.id }, data: { contactEmail: `${uniq('nc')}@staff.aigh.sa` } });
    expect((await hr.post(`/employees/${noContract.id}/invitations`)).body.error.code).toBe('NO_CURRENT_CONTRACT');
    const { emp } = await invitable();
    const otherUnitHr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'UNIT', scopeIds: [org.unitC.id] }] })).email);
    expect((await otherUnitHr.post(`/employees/${emp.id}/invitations`)).status).toBe(403);
    const sup = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    expect((await sup.post(`/employees/${emp.id}/invitations`)).status).toBe(403);
    const noMailApp = testApp(db);
    const hrNoMail = await signIn(noMailApp, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hrNoMail.post(`/employees/${emp.id}/invitations`)).body.error.code).toBe('EMAIL_OFF');
  });

  it('re-issuing revokes the earlier link; preview needs the token AND the Job Number and shows only a masked e-mail', async () => {
    const { emp, email } = await invitable();
    const first = await hr.post(`/employees/${emp.id}/invitations`);
    const second = await hr.post(`/employees/${emp.id}/invitations`);
    const oldToken = (await tokenFromMail(first.body.id)).token;
    const { token } = await tokenFromMail(second.body.id);
    expect((await pub(app, 'preview', { token: oldToken, jobNumber: emp.jobNumber })).body.error.code).toBe('INVITATION_INVALID');
    expect((await pub(app, 'preview', { token, jobNumber: 'J-WRONG' })).body.error.code).toBe('INVITATION_INVALID');
    const ok = await pub(app, 'preview', { token, jobNumber: ` ${emp.jobNumber.toLowerCase()} ` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ fullName: emp.fullName, jobNumber: emp.jobNumber, unit: 'Unit A', position: 'Staff Nurse', emailHint: `${email[0]}•••@staff.aigh.sa` });
    expect(JSON.stringify(ok.body)).not.toContain(email);
    const statuses = (await hr.get(`/employees/${emp.id}/invitations`)).body.items.map((i: { status: string }) => i.status);
    expect(statuses).toEqual(['OPEN', 'REVOKED']);
  });

  it('claim creates one self-service account linked to the employee; the link then stops working', async () => {
    const { emp, email } = await invitable();
    const { token } = await tokenFromMail((await hr.post(`/employees/${emp.id}/invitations`)).body.id);
    expect((await pub(app, 'claim', { token, jobNumber: emp.jobNumber, email: 'someone.else@staff.aigh.sa', password: NEW_PASSWORD })).body.error.code).toBe('INVITATION_INVALID');
    expect((await pub(app, 'claim', { token, jobNumber: emp.jobNumber, email, password: 'short' })).status).toBe(400);
    const claim = await pub(app, 'claim', { token, jobNumber: emp.jobNumber, email: email.toUpperCase(), password: NEW_PASSWORD });
    expect(claim.status).toBe(201);

    const me = await signIn(app, email, NEW_PASSWORD);
    const profile = (await me.get('/auth/me')).body;
    expect(profile.user).toMatchObject({ email, employeeId: emp.id });
    expect(profile.roles).toEqual([]); // the implicit staff role only — never supervisor authority
    expect((await pub(app, 'claim', { token, jobNumber: emp.jobNumber, email, password: NEW_PASSWORD })).body.error.code).toBe('INVITATION_INVALID');
    expect((await hr.get(`/employees/${emp.id}/invitations`)).body.items[0].status).toBe('CLAIMED');
    expect(await db.auditEntry.count({ where: { action: 'ACCOUNT_CLAIMED', resourceId: String(claim.body.userId) } })).toBe(1);
    expect((await hr.post(`/employees/${emp.id}/invitations`)).body.error.code).toBe('EMPLOYEE_HAS_ACCOUNT');
  });

  it('concurrent claims of one link produce exactly one account', async () => {
    const { emp, email } = await invitable();
    const { token } = await tokenFromMail((await hr.post(`/employees/${emp.id}/invitations`)).body.id);
    const results = await Promise.all(Array.from({ length: 5 }, () => pub(app, 'claim', { token, jobNumber: emp.jobNumber, email, password: NEW_PASSWORD })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400, 400, 400]);
    expect(await db.user.count({ where: { employeeId: emp.id } })).toBe(1);
  });

  it('an expired link, or an employee whose contract ended since, cannot be claimed', async () => {
    const a = await invitable();
    const inv = (await hr.post(`/employees/${a.emp.id}/invitations`)).body;
    const { token } = await tokenFromMail(inv.id);
    await db.invitation.update({ where: { id: inv.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await pub(app, 'claim', { token, jobNumber: a.emp.jobNumber, email: a.email, password: NEW_PASSWORD })).body.error.code).toBe('INVITATION_INVALID');

    const b = await invitable();
    const t2 = (await tokenFromMail((await hr.post(`/employees/${b.emp.id}/invitations`)).body.id)).token;
    await db.contract.updateMany({ where: { employeeId: b.emp.id }, data: { status: 'Terminated' } });
    expect((await pub(app, 'claim', { token: t2, jobNumber: b.emp.jobNumber, email: b.email, password: NEW_PASSWORD })).body.error.code).toBe('INVITATION_INVALID');
    expect(await db.user.count({ where: { employeeId: b.emp.id } })).toBe(0);
  });

  it('the database itself allows one open invitation per employee, and a used one must name its account', async () => {
    const { emp, email } = await invitable();
    const creator = (await makeUser(db)).id;
    const row = (tokenHash: string) => ({ employeeId: emp.id, email, tokenHash, expiresAt: new Date(Date.now() + 3600_000), createdById: creator });
    const first = await db.invitation.create({ data: row(uniq('h')) });
    await expect(db.invitation.create({ data: row(uniq('h')) })).rejects.toThrow();
    await expect(db.invitation.update({ where: { id: first.id }, data: { usedAt: new Date() } })).rejects.toThrow(/chk_invitations_used_has_user/);
    await expect(db.invitation.update({ where: { id: first.id }, data: { usedAt: new Date(), revokedAt: new Date(), userId: creator } })).rejects.toThrow(/chk_invitations_used_or_revoked/);
    await db.invitation.update({ where: { id: first.id }, data: { revokedAt: new Date() } });
    await expect(db.invitation.create({ data: row(uniq('h')) })).resolves.toBeTruthy(); // the old one is closed now
  });

  it('attempts are throttled per client, and the endpoints require the app origin', async () => {
    const limited = testApp(db, { ...MAIL, LOGIN_THROTTLE_MAX_PER_CLIENT: '3' });
    const fake = { token: 'A'.repeat(43), jobNumber: 'J-1' };
    for (let i = 0; i < 3; i++) expect((await pub(limited, 'preview', fake)).status).toBe(400);
    const blocked = await pub(limited, 'preview', fake);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await pub(limited, 'claim', { ...fake, email: 'x@staff.aigh.sa', password: NEW_PASSWORD })).status).toBe(429);
    expect((await request(app).post('/api/v1/auth/invitations/preview').send(fake)).body.error.code).toBe('ORIGIN_REJECTED');
  });
});
