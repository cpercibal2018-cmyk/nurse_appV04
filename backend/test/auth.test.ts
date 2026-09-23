// Authentication and sessions (spec §3.3, §3.4, §3.6; decision D-6, D-9).

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findChainBreaks } from '../src/lib/audit.js';
import type { Db } from '../src/lib/prisma.js';
import { createTokenService } from '../src/lib/tokens.js';
import { makeUser, openDb, ORIGIN, PASSWORD, signIn, TEST_URL, testApp, testEnv } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

describeDb('authentication', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });

  it('logs in with HttpOnly, path-scoped refresh cookie and a readable CSRF cookie', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email.toUpperCase()); // email is case-insensitive
    expect(c.loginResponse.body).toMatchObject({ expiresIn: 900 });
    const cookies = ([] as string[]).concat(c.loginResponse.headers['set-cookie'] ?? []);
    const refresh = cookies.find((x) => x.startsWith('nurseapp_refresh='))!;
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
    expect(refresh).toMatch(/SameSite=Lax/i);
    const csrf = cookies.find((x) => x.startsWith('nurseapp_csrf='))!;
    expect(csrf).not.toMatch(/HttpOnly/i);
    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: u.id, email: u.email });
    expect(me.body.effectiveRoles).toEqual(['EMPLOYEE']);
  });

  it('answers a wrong password and an unknown email identically, and audits the real account', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const wrong = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: 'wrong-password-123' });
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@nowhere.sa', password: 'wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const audit = await db.auditEntry.findFirst({ where: { action: 'LOGIN_FAILED', resourceId: String(u.id) } });
    expect(audit).not.toBeNull();
  });

  it('rejects an inactive account', async () => {
    const app = testApp(db);
    const u = await makeUser(db, { isActive: false });
    const res = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('limits failed attempts per account, then refuses even the right password (429 + Retry-After)', async () => {
    const app = testApp(db, { LOGIN_THROTTLE_MAX_PER_ACCOUNT: '3' });
    const u = await makeUser(db);
    for (let i = 0; i < 3; i++) await request(app).post('/api/v1/auth/login').send({ email: u.email, password: 'wrong-password-123' });
    const res = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('limits failed attempts per client address across accounts', async () => {
    const app = testApp(db, { LOGIN_THROTTLE_MAX_PER_CLIENT: '2' });
    const a = await makeUser(db);
    const b = await makeUser(db);
    await request(app).post('/api/v1/auth/login').send({ email: a.email, password: 'wrong-password-123' });
    await request(app).post('/api/v1/auth/login').send({ email: b.email, password: 'wrong-password-123' });
    const res = await request(app).post('/api/v1/auth/login').send({ email: (await makeUser(db)).email, password: PASSWORD });
    expect(res.status).toBe(429);
  });

  it('requires a valid bearer token; a forged "alg: none" token is refused', async () => {
    const app = testApp(db);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    const u = await makeUser(db);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: u.id, sid: 'x', csrf: 'x', exp: 9_999_999_999 })}.`;
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired access token', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    const claims = JSON.parse(Buffer.from(c.session.token.split('.')[1]!, 'base64url').toString()) as { sid: string; csrf: string };
    const tokens = createTokenService(testEnv().JWT_SECRET, 900);
    const old = tokens.sign({ sub: u.id, sid: claims.sid, csrf: claims.csrf }, Date.now() - 901_000);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${old}`)).status).toBe(401);
  });

  it('refresh rotates the token; replaying a consumed token revokes the whole family', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    const firstCookie = ([] as string[]).concat(c.loginResponse.headers['set-cookie'] ?? []).find((x) => x.startsWith('nurseapp_refresh='))!.split(';')[0]!;
    const firstCsrf = c.session.csrf;
    const rotated = await c.refresh();
    expect(rotated.status).toBe(200);
    expect((await c.get('/auth/me')).status).toBe(200);

    // An attacker replays the first (already consumed) refresh cookie.
    const replay = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN)
      .set('Cookie', [firstCookie, `nurseapp_csrf=${firstCsrf}`]).set('X-CSRF-Token', firstCsrf);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');
    // The legitimate session died with the family.
    expect((await c.get('/auth/me')).status).toBe(401);
    expect(await db.auditEntry.count({ where: { action: 'REFRESH_TOKEN_REUSE', resourceId: String(u.id) } })).toBe(1);
  });

  it('refresh requires the app Origin and the double-submitted CSRF token', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    const noCsrf = await c.agent.post('/api/v1/auth/refresh').set('Origin', ORIGIN);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
    const badOrigin = await c.agent.post('/api/v1/auth/refresh').set('Origin', 'https://evil.example').set('X-CSRF-Token', c.session.csrf);
    expect(badOrigin.body.error.code).toBe('ORIGIN_REJECTED');
  });

  it('state-changing requests need the session CSRF token and the app Origin', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    const bearer = `Bearer ${c.session.token}`;
    const noCsrf = await request(app).post('/api/v1/pam/end').set('Authorization', bearer).set('Origin', ORIGIN);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
    const otherCsrf = await request(app).post('/api/v1/pam/end').set('Authorization', bearer).set('Origin', ORIGIN).set('X-CSRF-Token', 'not-the-session-token');
    expect(otherCsrf.body.error.code).toBe('CSRF_FAILED');
    const badOrigin = await request(app).post('/api/v1/pam/end').set('Authorization', bearer).set('Origin', 'https://evil.example').set('X-CSRF-Token', c.session.csrf);
    expect(badOrigin.body.error.code).toBe('ORIGIN_REJECTED');
    expect((await c.post('/pam/end')).status).toBe(204);
  });

  it('logout ends the session at once, including the unexpired access token', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    const out = await c.agent.post('/api/v1/auth/logout').set('Origin', ORIGIN);
    expect(out.status).toBe(204);
    expect((await c.get('/auth/me')).status).toBe(401);
    // Cookies are cleared, so a refresh is refused (by the CSRF check first).
    expect((await c.refresh()).status).not.toBe(200);
  });

  it('enforces the idle limit and the absolute limit (D-6)', async () => {
    const app = testApp(db);
    const idle = await makeUser(db);
    const c1 = await signIn(app, idle.email);
    await db.refreshSession.updateMany({ where: { userId: idle.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await c1.get('/auth/me')).status).toBe(401);
    expect((await c1.refresh()).body.error.code).toBe('SESSION_EXPIRED');

    const abs = await makeUser(db);
    const c2 = await signIn(app, abs.email);
    await db.refreshSession.updateMany({ where: { userId: abs.id }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    expect((await c2.refresh()).status).toBe(401);
  });

  it('a rotated session keeps its original absolute boundary', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    const before = await db.refreshSession.findFirstOrThrow({ where: { userId: u.id } });
    await c.refresh();
    const live = await db.refreshSession.findFirstOrThrow({ where: { userId: u.id, revokedAt: null } });
    expect(live.id).not.toBe(before.id);
    expect(live.absoluteExpiresAt.getTime()).toBe(before.absoluteExpiresAt.getTime());
  });

  it('password change verifies the current password, applies the 12–72 rule and revokes all sessions', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    const other = await signIn(app, u.email); // a second device
    expect((await c.post('/auth/password', { currentPassword: 'wrong-password-123', newPassword: 'a-brand-new-password' })).body.error.code).toBe('CURRENT_PASSWORD_WRONG');
    expect((await c.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'short' })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await c.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'x'.repeat(73) })).body.error.code).toBe('VALIDATION_FAILED');
    // 40 Arabic letters: within 72 characters but 80 bytes, over bcrypt's 72-byte limit.
    expect((await c.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'ب'.repeat(40) })).body.error.code).toBe('VALIDATION_FAILED');
    const ok = await c.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(ok.status).toBe(204);
    expect((await other.get('/auth/me')).status).toBe(401);
    await expect(signIn(app, u.email)).rejects.toThrow(/401/);
    expect((await signIn(app, u.email, 'a-brand-new-password')).loginResponse.status).toBe(200);
  });

  it('deactivating an account ends its sessions', async () => {
    const app = testApp(db);
    const u = await makeUser(db);
    const c = await signIn(app, u.email);
    await db.user.update({ where: { id: u.id }, data: { isActive: false } });
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('break-glass login sounds the siren and grants root without PAM, capped at 4 hours (R18, D-9)', async () => {
    const app = testApp(db);
    const admin = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    const bg = await makeUser(db, { isBreakGlass: true });
    const c = await signIn(app, bg.email);

    const event = await db.breakGlassEvent.findFirstOrThrow({ where: { actorUserId: bg.id } });
    expect(event.expiresAt.getTime() - event.activatedAt.getTime()).toBe(4 * 3600_000);
    expect(await db.auditEntry.count({ where: { action: 'BREAK_GLASS_ACTIVATED', resourceId: String(event.id), priority: 'HIGH' } })).toBe(1);
    const alert = await db.notification.findFirst({ where: { recipientId: admin.id, eventKey: `break-glass:${event.id}` } });
    expect(alert?.priority).toBe('CRITICAL');
    const session = await db.refreshSession.findFirstOrThrow({ where: { userId: bg.id } });
    expect(session.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(event.expiresAt.getTime() + 1000);

    // Root access without elevation.
    expect((await c.get('/users')).status).toBe(200);
    // After the 4-hour window the account is locked out.
    await db.$executeRaw`UPDATE break_glass_events SET expires_at = now() - interval '1 second' WHERE id = ${event.id}`;
    expect((await c.get('/users')).status).toBe(401);
  });

  it('break-glass events cannot be deleted', async () => {
    const bg = await makeUser(db, { isBreakGlass: true });
    const ev = await db.breakGlassEvent.create({ data: { actorUserId: bg.id, reason: 'x', ipAddress: '1.1.1.1', expiresAt: new Date(Date.now() + 1000) } });
    await expect(db.breakGlassEvent.delete({ where: { id: ev.id } })).rejects.toThrow();
  });

  it('leaves the audit chain intact', async () => {
    expect(await findChainBreaks(db)).toEqual([]);
  });
});
