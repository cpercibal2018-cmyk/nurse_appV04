// FHIR API clients (spec §14.1, D-63): a System Admin registers another system;
// it exchanges its id and secret for a short token (OAuth 2.0 client
// credentials) and reads FHIR system-wide within its scopes — and nothing else.
// A new secret or a revocation ends its tokens at once; failures are throttled
// and audited; the secret is never stored or logged in clear.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { createJwt, sha256hex } from '../src/lib/tokens.js';
import { clientTokenKey } from '../src/modules/interop/api-clients.js';
import { makeNurse, makeOrg, makeUser, openDb, signIn, TEST_URL, testApp, testEnv, uniq } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const TOKEN = '/api/v1/fhir/token';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

describeDb('FHIR API clients (D-63)', () => {
  let db: Db;
  let app: Express;
  let sa: Awaited<ReturnType<typeof signIn>>;
  let org: Awaited<ReturnType<typeof makeOrg>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    org = await makeOrg(db);
    sa = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  async function register(scopes?: string[]) {
    const res = await sa.post('/api-clients', { name: uniq('HIS'), ...(scopes ? { scopes } : {}) });
    expect(res.status).toBe(201);
    return { id: res.body.client.id as number, clientId: res.body.client.clientId as string, secret: res.body.clientSecret as string, body: res.body };
  }
  const tokenFor = (id: string, secret: string, form: Record<string, string> = {}) =>
    request(app).post(TOKEN).set('Authorization', basic(id, secret)).type('form').send({ grant_type: 'client_credentials', ...form });

  it('registers a client: the secret is returned once and stored only as its hash; audited HIGH', async () => {
    const c = await register();
    expect(c.clientId).toMatch(/^cl_/);
    expect(c.secret).toMatch(/^nwcs_.{43}$/);
    expect(c.body.client).not.toHaveProperty('secretHash');
    expect(c.body.client.scopes).toEqual(['system/Practitioner.read', 'system/PractitionerRole.read']);
    const row = await db.apiClient.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.secretHash).toBe(sha256hex(c.secret));
    expect(JSON.stringify((await sa.get('/api-clients')).body)).not.toContain(c.secret);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'API_CLIENT_CREATED', resourceId: String(c.id) } });
    expect(audit.priority).toBe('HIGH');
    expect(JSON.stringify(audit.changes)).not.toContain(c.secret);

    expect((await sa.post('/api-clients', { name: c.body.client.name.toUpperCase() })).status).toBe(409); // one live client per name
    expect((await sa.post('/api-clients', { name: uniq('X'), scopes: ['system/*.write'] })).status).toBe(400);
  });

  it('client credentials → a Bearer token that reads FHIR system-wide, logged as the client', async () => {
    const c = await register();
    const outside = await makeNurse(db, org.unitC.id);
    const res = await tokenFor(c.clientId, c.secret);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'system/Practitioner.read system/PractitionerRole.read' });
    // The secret in the body also works (RFC 6749 §2.3.1).
    expect((await request(app).post(TOKEN).type('form').send({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret })).status).toBe(200);

    const bearer = `Bearer ${res.body.access_token}`;
    const p = await request(app).get(`/api/v1/fhir/Practitioner/${outside.emp.id}`).set('Authorization', bearer);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ resourceType: 'Practitioner', id: String(outside.emp.id) });
    expect((await request(app).get(`/api/v1/fhir/PractitionerRole?practitioner=Practitioner/${outside.emp.id}`).set('Authorization', bearer)).body.total).toBe(1);
    expect((await request(app).get('/api/v1/fhir/metadata').set('Authorization', bearer)).body.rest[0].security.service[0].coding[0].code).toBe('OAuth');
    expect((await db.apiClient.findUniqueOrThrow({ where: { id: c.id } })).lastTokenAt).not.toBeNull();

    // Recorded in the request log as the client, without the secret.
    await app.locals.requestLog.flush();
    const logged = await db.requestLogEntry.findFirstOrThrow({ where: { sessionFamily: `client:${c.clientId}`, path: `/api/v1/fhir/Practitioner/${outside.emp.id}` } });
    expect(logged).toMatchObject({ actorUserId: null, actorRoles: 'API_CLIENT', statusCode: 200 });
    const requests = await sa.get(`/audit/requests?path=${encodeURIComponent(`/fhir/Practitioner/${outside.emp.id}`)}`);
    expect(requests.body.items.find((x: { sessionFamily: string }) => x.sessionFamily === `client:${c.clientId}`).actorName).toMatch(/^API client: HIS/);
  });

  it('a client token opens nothing but FHIR reads, and only its scopes', async () => {
    const c = await register(['system/PractitionerRole.read']);
    const { emp } = await makeNurse(db, org.unitA.id);
    const token = (await tokenFor(c.clientId, c.secret)).body.access_token as string;
    const bearer = `Bearer ${token}`;
    expect((await request(app).get(`/api/v1/fhir/PractitionerRole/${emp.id}`).set('Authorization', bearer)).status).toBe(200);
    const denied = await request(app).get(`/api/v1/fhir/Practitioner/${emp.id}`).set('Authorization', bearer);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ resourceType: 'OperationOutcome', issue: [{ code: 'forbidden' }] });
    // Not a user token anywhere else, nor for writes.
    for (const path of ['/api/v1/employees', '/api/v1/auth/me', '/api/v1/api-clients', `/api/v1/employees/${emp.id}`]) {
      expect((await request(app).get(path).set('Authorization', bearer)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/v1/fhir/Practitioner').set('Authorization', bearer)).status).toBe(403);
    // Asking for a scope it lacks.
    expect((await tokenFor(c.clientId, c.secret, { scope: 'system/Practitioner.read' })).body.error).toBe('invalid_scope');
    // A user token signed with the client key does not work as one, and the reverse: separate keys.
    const forged = createJwt(testEnv().JWT_SECRET).sign({ cid: c.id, ver: 1, scope: 'system/Practitioner.read' }, 900);
    expect((await request(app).get(`/api/v1/fhir/Practitioner/${emp.id}`).set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const asUser = createJwt(clientTokenKey(testEnv().JWT_SECRET)).sign({ sub: 1, sid: 'x', csrf: 'y' }, 900);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${asUser}`)).status).toBe(401);
  });

  it('a new secret ends the old secret and its tokens; revoking ends everything; both audited', async () => {
    const c = await register();
    const { emp } = await makeNurse(db, org.unitA.id);
    const old = `Bearer ${(await tokenFor(c.clientId, c.secret)).body.access_token}`;
    const rotated = await sa.post(`/api-clients/${c.id}/secret`, {});
    expect(rotated.status).toBe(200);
    expect(rotated.body.client.secretVersion).toBe(2);
    const ended = await request(app).get(`/api/v1/fhir/Practitioner/${emp.id}`).set('Authorization', old);
    expect(ended.status).toBe(401);
    expect(ended.body.error.message).toMatch(/revoked or its secret replaced/);
    expect((await tokenFor(c.clientId, c.secret)).status).toBe(401);
    const fresh = `Bearer ${(await tokenFor(c.clientId, rotated.body.clientSecret)).body.access_token}`;
    expect((await request(app).get(`/api/v1/fhir/Practitioner/${emp.id}`).set('Authorization', fresh)).status).toBe(200);

    expect((await sa.post(`/api-clients/${c.id}/revoke`, {})).status).toBe(200);
    expect((await request(app).get(`/api/v1/fhir/Practitioner/${emp.id}`).set('Authorization', fresh)).status).toBe(401);
    const refused = await tokenFor(c.clientId, rotated.body.clientSecret);
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe('invalid_client');
    expect((await sa.post(`/api-clients/${c.id}/secret`, {})).status).toBe(409);
    expect((await sa.post(`/api-clients/${c.id}/revoke`, {})).status).toBe(409);
    const actions = (await db.auditEntry.findMany({ where: { resource: 'api_client', resourceId: String(c.id) }, orderBy: { id: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['API_CLIENT_CREATED', 'API_CLIENT_SECRET_REPLACED', 'API_CLIENT_REVOKED', 'API_CLIENT_AUTH_FAILED']));
    // The name is free again once revoked.
    expect((await sa.post('/api-clients', { name: rotated.body.client.name })).status).toBe(201);
  });

  it('OAuth errors: wrong grant, missing or doubled credentials, and throttled failures', async () => {
    const c = await register();
    expect((await tokenFor(c.clientId, c.secret, { grant_type: 'password' })).body.error).toBe('unsupported_grant_type');
    const none = await request(app).post(TOKEN).type('form').send({ grant_type: 'client_credentials' });
    expect(none.status).toBe(401);
    expect((await request(app).post(TOKEN).set('Authorization', basic(c.clientId, c.secret)).type('form').send({ grant_type: 'client_credentials', client_id: c.clientId })).body.error).toBe('invalid_request');
    const wrong = await tokenFor(c.clientId, 'nwcs_wrong');
    expect(wrong.status).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Basic realm="fhir"');

    // Throttled per client id (LOGIN_THROTTLE_MAX_PER_ACCOUNT failures), then even the right secret waits.
    const throttled = testApp(db, { LOGIN_THROTTLE_MAX_PER_ACCOUNT: '3' });
    const attempt = (secret: string) => request(throttled).post(TOKEN).set('Authorization', basic(c.clientId, secret)).type('form').send({ grant_type: 'client_credentials' });
    for (let i = 0; i < 3; i++) expect((await attempt('nwcs_wrong')).status).toBe(401);
    const blocked = await attempt(c.secret);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // The token request's body hash leaves the secret out (it matches the body without it).
    const rid = uniq('rid');
    const form = { grant_type: 'client_credentials', client_id: c.clientId };
    await request(app).post(TOKEN).set('X-Request-Id', rid).type('form').send({ ...form, client_secret: c.secret });
    await app.locals.requestLog.flush();
    const row = await db.requestLogEntry.findFirstOrThrow({ where: { requestId: rid } });
    expect(row.paramsHash).toBe(app.locals.requestLog.hashBody(form));
  });

  it('only an elevated System Admin manages clients', async () => {
    const hr = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await hr.get('/api-clients')).status).toBe(403);
    const dormant = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] })).email);
    expect((await dormant.post('/api-clients', { name: uniq('X') })).body.error.code).toBe('PAM_ELEVATION_REQUIRED');
  });
});
