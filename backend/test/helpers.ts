// Shared fixtures for HTTP integration tests against TEST_DATABASE_URL. Tests
// create uniquely named rows and leave them (the audit trail is append-only,
// so audited users cannot be deleted); CI starts from an empty database.

import 'dotenv/config';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { createPasswordService } from '../src/lib/passwords.js';
import { createPrisma, type Db } from '../src/lib/prisma.js';
import type { AppRole, ScopeType } from '../src/generated/prisma/client.js';

export const TEST_URL = process.env.TEST_DATABASE_URL;
export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct-horse-battery';

let seq = 0;
/** Unique per run and per call, so reruns never collide with leftovers. */
export const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ NODE_ENV: 'test', DATABASE_URL: TEST_URL!, JWT_SECRET: 'test-only-secret-0123456789-abcdefghijklmnop', ...overrides });
}

// bcrypt cost 4 keeps the suite fast; production uses BCRYPT_ROUNDS (12).
export const fastPasswords = createPasswordService(4);

export function testApp(db: Db, envOverrides: Record<string, string> = {}): Express {
  return createApp({ env: testEnv(envOverrides), db, passwords: fastPasswords });
}

export function openDb(): Db {
  return createPrisma(TEST_URL!);
}

export async function makeOrg(db: Db) {
  const dept = await db.department.create({ data: { code: uniq('D'), name: 'Test department' } });
  const dept2 = await db.department.create({ data: { code: uniq('D'), name: 'Other department' } });
  const unitA = await db.unit.create({ data: { code: uniq('UA'), name: 'Unit A', departmentId: dept.id } });
  const unitB = await db.unit.create({ data: { code: uniq('UB'), name: 'Unit B', departmentId: dept.id } });
  const unitC = await db.unit.create({ data: { code: uniq('UC'), name: 'Unit C', departmentId: dept2.id } });
  await db.position.upsert({ where: { code: 'SN' }, update: {}, create: { code: 'SN', title: 'Staff Nurse', tier: 'Clinical', isSchedulable: true } });
  return { dept, dept2, unitA, unitB, unitC };
}

export async function makeEmployee(db: Db, unitId: number | null) {
  return db.employee.create({
    data: { jobNumber: uniq('J'), firstName: 'Test', lastName: 'Nurse', fullName: 'x', contactEmail: 't@x.sa', positionCode: 'SN', unitId },
  });
}

interface MakeUser {
  roles?: Array<{ role: AppRole; scopeType: ScopeType; scopeIds?: number[] }>;
  employeeId?: number | null;
  isBreakGlass?: boolean;
  pam?: boolean;
  isActive?: boolean;
}

export async function makeUser(db: Db, opts: MakeUser = {}) {
  const email = `${uniq('u')}@test.aigh.sa`;
  const user = await db.user.create({
    data: {
      email, displayName: 'Test User', passwordHash: await fastPasswords.hash(PASSWORD),
      employeeId: opts.employeeId ?? null, isBreakGlass: opts.isBreakGlass ?? false, isActive: opts.isActive ?? true,
    },
  });
  for (const r of opts.roles ?? []) {
    await db.roleAssignment.create({
      data: { userId: user.id, role: r.role, scopeType: r.scopeType, scopeIds: r.scopeIds ?? [], reason: 'test fixture grant with a long reason', grantedById: user.id },
    });
  }
  if (opts.pam) await db.privilegedSession.create({ data: { userId: user.id, reason: 'test elevation', expiresAt: new Date(Date.now() + 3600_000) } });
  return { ...user, email };
}

/** A signed-in client: cookie jar + bearer + CSRF headers on every call. */
export async function signIn(app: Express, email: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const session = { token: res.body.token as string, csrf: res.body.csrfToken as string };
  const withAuth = (r: request.Test) => r.set('Authorization', `Bearer ${session.token}`).set('X-CSRF-Token', session.csrf).set('Origin', ORIGIN);
  return {
    agent,
    session,
    loginResponse: res,
    get: (path: string) => withAuth(agent.get(`/api/v1${path}`)),
    post: (path: string, body?: object) => withAuth(agent.post(`/api/v1${path}`)).send(body ?? {}),
    patch: (path: string, body?: object) => withAuth(agent.patch(`/api/v1${path}`)).send(body ?? {}),
    put: (path: string, body?: object) => withAuth(agent.put(`/api/v1${path}`)).send(body ?? {}),
    del: (path: string) => withAuth(agent.delete(`/api/v1${path}`)),
    /** Raw file upload: the body is the file, its name in X-File-Name. */
    upload: (path: string, bytes: Buffer, contentType: string, fileName = 'evidence.pdf') =>
      withAuth(agent.post(`/api/v1${path}`)).set('Content-Type', contentType).set('X-File-Name', encodeURIComponent(fileName)).send(bytes),
    refresh: async () => {
      const r = await agent.post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('X-CSRF-Token', session.csrf);
      if (r.status === 200) { session.token = r.body.token; session.csrf = r.body.csrfToken; }
      return r;
    },
  };
}

/** A schedulable nurse in `unitId` with an Active contract covering the next year, plus an optional linked login. */
export async function makeNurse(db: Db, unitId: number, opts: { account?: boolean } = {}) {
  const emp = await makeEmployee(db, unitId);
  const start = new Date(Date.now() - 30 * 86_400_000);
  const end = new Date(Date.now() + 365 * 86_400_000);
  await db.contract.create({ data: { employeeId: emp.id, jobNumber: emp.jobNumber, status: 'Active', startDate: start, endDate: end } });
  const user = opts.account ? await makeUser(db, { employeeId: emp.id }) : null;
  return { emp, user };
}

/** A credential template with one number field and issue/expiry date fields (spec §5.1.3 shape). */
export async function makeTemplate(db: Db, opts: { gracePeriodDays?: number; requiresUpload?: boolean; hasExpiry?: boolean } = {}) {
  await db.credentialCategory.upsert({ where: { code: 'LICENSURE' }, update: {}, create: { code: 'LICENSURE', name: 'Licensure' } });
  return db.credentialTemplate.create({
    data: {
      code: uniq('T').toUpperCase(), name: 'Test licence', categoryCode: 'LICENSURE',
      hasExpiry: opts.hasExpiry ?? true, requiresUpload: opts.requiresUpload ?? true, gracePeriodDays: opts.gracePeriodDays ?? 0,
      fieldDefs: [
        { key: 'licence_number', label: 'Licence number', type: 'text', required: true, displayOrder: 1 },
        { key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 2, isIssueDate: true },
        { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true, displayOrder: 3, isExpiryDate: true },
      ],
    },
  });
}

/** Minimal valid files for the magic-byte checks. */
export const FILES = {
  pdf: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  exe: Buffer.from('MZ\x90\x00this is not a document'),
};
