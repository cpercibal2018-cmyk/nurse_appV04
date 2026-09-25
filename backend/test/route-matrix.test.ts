// Security matrix for EVERY route the app registers (Phase 15: "RBAC matrix
// tests per role", "no unscoped reads", default deny R15). Routes are read from
// the running Express app, so a new route is covered automatically:
//   1. Without a token every route except the public ones answers 401.
//   2. For each role persona the route-level gate matches permissions.ts
//      exactly: allowed personas never get FORBIDDEN / PAM_ELEVATION_REQUIRED,
//      the others always do.
//   3. A signed-in route with no permission gate must be on the reviewed list
//      below (own-or-scoped routes whose service decides access), so a route
//      cannot be added without either a gate or a review.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Db } from '../src/lib/prisma.js';
import { PERMISSIONS, type Permission } from '../src/modules/users/permissions.js';
import { makeOrg, makeUser, openDb, ORIGIN, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

interface RouteInfo { method: string; path: string; permission: Permission | null }
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { permission?: Permission } }> }; handle?: { stack?: Layer[] } };

/** Every route of the app with its full path and route-level permission. */
function routesOf(app: Express): RouteInfo[] {
  const out: RouteInfo[] = [];
  const collect = (stack: Layer[], prefix: string) => {
    for (const l of stack) {
      if (l.route) {
        const permission = l.route.stack.map((s) => s.handle.permission).find((p) => p !== undefined) ?? null;
        for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + l.route.path, permission });
      } else if (l.handle?.stack) {
        // Express 5 no longer exposes mount paths; app.ts mounts the auth router
        // at /api/v1/auth and every other router on the /api/v1 router.
        const isAuth = l.handle.stack.some((x) => x.route?.path === '/login');
        collect(l.handle.stack, isAuth ? '/api/v1/auth' : prefix === '' ? '/api/v1' : prefix);
      }
    }
  };
  collect((app as unknown as { router: { stack: Layer[] } }).router.stack, '');
  return out;
}

const PUBLIC = new Set([
  'GET /api/v1/health', 'POST /api/v1/auth/login', 'POST /api/v1/auth/refresh', 'POST /api/v1/auth/logout',
  // Registration by invitation (spec §3.2): no account exists yet; the token, Job Number, Origin check and throttle guard them.
  'POST /api/v1/auth/invitations/preview', 'POST /api/v1/auth/invitations/claim',
  // Password reset (D-50): the e-mailed token, Origin check and throttles guard them.
  'POST /api/v1/auth/password-reset/request', 'POST /api/v1/auth/password-reset/complete',
  // The second sign-in step (spec §3.5): the single-use challenge from a correct password, Origin check and throttles guard them.
  'POST /api/v1/auth/mfa/verify', 'POST /api/v1/auth/mfa/enroll/start', 'POST /api/v1/auth/mfa/enroll/confirm',
  // D-53: a single-use, 60-second link issued after the usual document authorisation; the token is the credential.
  'GET /api/v1/files/:token{/:name}',
  // D-63: the OAuth 2.0 token endpoint for other systems; the client id and secret are the credentials, failures throttled.
  'POST /api/v1/fhir/token',
]);

/** Signed-in routes without a route gate: the service checks own-or-scoped access. Reviewed list. */
const SELF_OR_SCOPED = [
  'GET /api/v1/auth/sessions', 'GET /api/v1/auth/me', 'POST /api/v1/auth/password',
  'GET /api/v1/auth/mfa', 'POST /api/v1/auth/mfa/setup', 'POST /api/v1/auth/mfa/setup/confirm', // own authenticator only
  'POST /api/v1/auth/mfa/recovery-codes', 'POST /api/v1/auth/mfa/disable',
  'GET /api/v1/eligibility/me', 'GET /api/v1/eligibility/:id', // viewerOf: own, scoped HR or scoped supervisor
  'GET /api/v1/pam/status', 'POST /api/v1/pam/elevate', 'POST /api/v1/pam/end', // own elevation only; elevate needs a System Admin assignment
  'GET /api/v1/credentials/:id', 'POST /api/v1/credentials/:id/renewal', 'POST /api/v1/credentials/:id/documents',
  'GET /api/v1/credentials/:id/documents', 'GET /api/v1/credentials/:id/documents/:docId', 'POST /api/v1/credentials/:id/documents/:docId/link',
  'GET /api/v1/employees/me', 'PATCH /api/v1/employees/me/contact', 'GET /api/v1/employees/:id', // contact: own phones only (D-35)
  'GET /api/v1/contracts/me', 'GET /api/v1/contracts/:id', 'GET /api/v1/contracts/:id/documents', 'GET /api/v1/contracts/:id/documents/:docId', 'POST /api/v1/contracts/:id/documents/:docId/link',
  'GET /api/v1/roster/me', 'GET /api/v1/attendance/me',
  'GET /api/v1/notifications', 'POST /api/v1/notifications/:id/read', 'POST /api/v1/notifications/read-all',
  'GET /api/v1/pdpl/requests/me', 'POST /api/v1/pdpl/requests/me', 'GET /api/v1/pdpl/requests/me/:id/export', // own data-subject requests (D-55)
].sort();

const concrete = (path: string) => path.replace(/:id|:docId/g, '999999').replace(/:code/g, 'ZZ').replace(/:name/g, 'zz').replace(/:employeeId/g, '999999');

type Persona = 'EMPLOYEE' | 'SUPERVISOR' | 'HR_ADMIN' | 'SA_DORMANT' | 'SA_ELEVATED';
function expected(permission: Permission, persona: Persona): 'ALLOW' | 'FORBIDDEN' | 'PAM_ELEVATION_REQUIRED' {
  const roles: readonly string[] = PERMISSIONS[permission];
  if (roles.includes('EMPLOYEE')) return 'ALLOW';
  if (persona === 'SUPERVISOR' && roles.includes('SUPERVISOR')) return 'ALLOW';
  if (persona === 'HR_ADMIN' && roles.includes('HR_ADMIN')) return 'ALLOW';
  if (persona === 'SA_ELEVATED' && roles.includes('SYSTEM_ADMIN')) return 'ALLOW';
  if (persona === 'SA_DORMANT' && roles.includes('SYSTEM_ADMIN')) return 'PAM_ELEVATION_REQUIRED';
  return 'FORBIDDEN';
}

describeDb('route security matrix', () => {
  let db: Db;
  let app: Express;
  let routes: RouteInfo[];
  const clients = {} as Record<Persona, Awaited<ReturnType<typeof signIn>>>;

  beforeAll(async () => {
    db = openDb();
    app = testApp(db);
    routes = routesOf(app);
    const org = await makeOrg(db);
    clients.EMPLOYEE = await signIn(app, (await makeUser(db)).email);
    clients.SUPERVISOR = await signIn(app, (await makeUser(db, { roles: [{ role: 'SUPERVISOR', scopeType: 'UNIT', scopeIds: [org.unitA.id] }] })).email);
    clients.HR_ADMIN = await signIn(app, (await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] })).email);
    clients.SA_DORMANT = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] })).email);
    clients.SA_ELEVATED = await signIn(app, (await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }], pam: true })).email);
  });
  afterAll(async () => { await db.$disconnect(); });

  it('finds the whole API', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
  });

  it('every non-public route answers 401 without a token', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
      const res = await request(app)[r.method.toLowerCase() as 'get'](concrete(r.path)).set('Origin', ORIGIN).send({});
      if (res.status !== 401) leaks.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
  });

  it('routes without a permission gate are exactly the reviewed own-or-scoped list', () => {
    const ungated = routes.filter((r) => r.permission === null && !PUBLIC.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`).sort();
    expect(ungated).toEqual(SELF_OR_SCOPED);
  });

  it('every permission in the table guards at least one route', () => {
    const used = new Set(routes.map((r) => r.permission));
    expect((Object.keys(PERMISSIONS) as Permission[]).filter((p) => !used.has(p))).toEqual([]);
  });

  it.each(['EMPLOYEE', 'SUPERVISOR', 'HR_ADMIN', 'SA_DORMANT', 'SA_ELEVATED'] as Persona[])('%s gets exactly the access permissions.ts grants', async (persona) => {
    const wrong: string[] = [];
    const c = clients[persona];
    for (const r of routes.filter((x) => x.permission)) {
      const path = concrete(r.path).replace('/api/v1', '');
      const req = r.method === 'GET' ? c.get(path) : r.method === 'POST' ? c.post(path, {}) : r.method === 'PUT' ? c.put(path, {}) : r.method === 'PATCH' ? c.patch(path, {}) : c.del(path).send({});
      const res = await req.set('Idempotency-Key', randomUUID());
      const gate = res.status === 403 && ['FORBIDDEN', 'PAM_ELEVATION_REQUIRED'].includes(res.body?.error?.code) ? res.body.error.code : 'ALLOW';
      const want = expected(r.permission!, persona);
      if (gate !== want) wrong.push(`${r.method} ${r.path} [${r.permission}] → ${gate}, expected ${want}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
