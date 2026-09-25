// Request-level forensic log (spec §9.2, D-52).

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { createRequestLog, RETENTION_DAYS, type RequestLog } from '../src/lib/request-log.js';
import { requestLogPurge } from '../src/jobs/request-log-purge.js';
import { createApp } from '../src/app.js';
import { fastPasswords, makeUser, openDb, ORIGIN, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

describeDb('request log (spec §9.2)', () => {
  let db: Db;
  let app: Express;
  let log: RequestLog;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    log = app.locals.requestLog as RequestLog;
  });
  afterAll(async () => { await db.$disconnect(); });

  const row = async (requestId: unknown) => {
    await log.flush();
    return db.requestLogEntry.findFirst({ where: { requestId: String(requestId) } });
  };

  it('records a signed-in request with its actor, roles, session, status and timing — without the query string', async () => {
    const u = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const c = await signIn(app, u.email);
    const res = await c.get('/users?q=secret-search-term').set('User-Agent', 'e2e-agent/1.0');
    expect(res.status).toBe(200);
    const r = await row(res.headers['x-request-id']);
    expect(r).toMatchObject({
      actorUserId: u.id, actorRoles: 'HR_ADMIN', method: 'GET', path: '/api/v1/users', statusCode: 200,
      userAgent: 'e2e-agent/1.0', paramsHash: null, errorCode: null,
    });
    expect(r!.sessionFamily).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(r!.durationMs).toBeGreaterThanOrEqual(0);
    expect(r!.ipAddress).toBeTruthy();
    expect(JSON.stringify({ ...r, id: String(r!.id) })).not.toContain('secret-search-term');
  });

  it('records denials and failures, with the error code, even before anyone is signed in', async () => {
    const u = await makeUser(db);
    const bad = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: 'wrong-password-123' });
    expect(await row(bad.headers['x-request-id'])).toMatchObject({ actorUserId: null, statusCode: 401, errorCode: 'INVALID_CREDENTIALS', path: '/api/v1/auth/login' });

    const staff = await signIn(app, u.email);
    const denied = await staff.get('/users');
    expect(await row(denied.headers['x-request-id'])).toMatchObject({ actorUserId: u.id, actorRoles: 'EMPLOYEE', statusCode: 403, errorCode: 'FORBIDDEN' });

    const anon = await request(app).get('/api/v1/nurses');
    expect(await row(anon.headers['x-request-id'])).toMatchObject({ statusCode: 401, errorCode: 'UNAUTHENTICATED' });
    const missing = await staff.get('/no-such-route');
    expect(await row(missing.headers['x-request-id'])).toMatchObject({ statusCode: 404, errorCode: 'ROUTE_NOT_FOUND' });
  });

  it('hashes the body without its secrets: two logins differing only in the password hash the same', async () => {
    const email = `${uniq('nobody')}@test.aigh.sa`;
    const a = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password: 'first-password-1' });
    const b = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password: 'second-password-2' });
    const c = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: `x${email}`, password: 'first-password-1' });
    const [ra, rb, rc] = await Promise.all([row(a.headers['x-request-id']), row(b.headers['x-request-id']), row(c.headers['x-request-id'])]);
    expect(ra!.paramsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rb!.paramsHash).toBe(ra!.paramsHash);
    expect(rc!.paramsHash).not.toBe(ra!.paramsHash);
    // Keyed: not the plain SHA-256 of the redacted body.
    expect(ra!.paramsHash).not.toBe(crypto.createHash('sha256').update(JSON.stringify({ email })).digest('hex'));
    // Nested secrets are removed too.
    expect(log.hashBody({ a: 1, nested: { token: 'x' } })).toBe(log.hashBody({ a: 1, nested: { token: 'y' } }));
    expect(log.hashBody({})).toBeNull();
  });

  it('skips the liveness probe', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(await row(res.headers['x-request-id'])).toBeNull();
  });

  it('a database failure never reaches the request, and rows are batched', async () => {
    let calls = 0;
    const broken = createRequestLog({ requestLogEntry: { createMany: async () => { calls++; throw new Error('db down'); } } } as never, Buffer.alloc(32));
    const withBroken = createApp({ env: testEnv(), db, passwords: fastPasswords, throttleNamespace: uniq('app') + ':', requestLog: broken });
    const res = await request(withBroken).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'a@b.sa', password: 'x' });
    expect(res.status).toBe(401);
    await broken.flush();
    expect(calls).toBe(1);
    await broken.flush(); // nothing left: the failed batch was dropped, not retried forever
    expect(calls).toBe(1);
  });

  it('System Admins read it with filters; nobody else can', async () => {
    const sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
    const u = await makeUser(db);
    const target = await signIn(app, u.email);
    const probe = await target.get('/users'); // a 403 to find
    await log.flush();
    const byRequest = await sa.get(`/audit/requests?requestId=${probe.headers['x-request-id']}`);
    expect(byRequest.status).toBe(200);
    expect(byRequest.body.total).toBe(1);
    expect(byRequest.body.items[0]).toMatchObject({ id: expect.any(String), actorUserId: u.id, actorName: 'Test User', statusCode: 403 });
    const mine = await sa.get(`/audit/requests?actor=${u.id}&status=4xx&method=GET&path=/users`);
    expect(mine.body.items.every((x: { actorUserId: number; statusCode: number }) => x.actorUserId === u.id && x.statusCode >= 400 && x.statusCode < 500)).toBe(true);
    expect(mine.body.total).toBeGreaterThanOrEqual(1);
    expect((await sa.get('/audit/requests?status=403&errorCode=FORBIDDEN&pageSize=5')).body.items.length).toBeGreaterThanOrEqual(1);
    expect((await sa.get('/audit/requests?status=9xx')).status).toBe(400);
    const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hr.get('/audit/requests')).status).toBe(403);
  });

  it('rows cannot be edited, and the daily purge removes those past the retention period', async () => {
    const old = new Date(Date.now() - (RETENTION_DAYS + 2) * 86_400_000);
    const id = uniq('old-');
    await db.requestLogEntry.create({ data: { requestId: id, at: old, method: 'GET', path: '/api/v1/x', statusCode: 200, durationMs: 1 } });
    const keep = uniq('new-');
    await db.requestLogEntry.create({ data: { requestId: keep, at: new Date(Date.now() - (RETENTION_DAYS - 2) * 86_400_000), method: 'GET', path: '/api/v1/x', statusCode: 200, durationMs: 1 } });
    await expect(db.requestLogEntry.updateMany({ where: { requestId: keep }, data: { statusCode: 500 } })).rejects.toThrow(/append-only/);
    const out = await requestLogPurge(db);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(await db.requestLogEntry.count({ where: { requestId: id } })).toBe(0);
    expect(await db.requestLogEntry.count({ where: { requestId: keep } })).toBe(1);
  });
});
