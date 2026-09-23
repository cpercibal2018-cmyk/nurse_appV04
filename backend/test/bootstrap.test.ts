// P6: an empty database becomes usable only through the one-time bootstrap,
// which creates two hospital-wide administrators (so four-eyes works) and
// refuses to run again.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapAdministrators, BootstrapRefused } from '../src/cli/bootstrap.js';
import { createPasswordService } from '../src/lib/passwords.js';
import type { Db } from '../src/lib/prisma.js';
import { createFreshDatabase } from './fresh-db.js';
import { ORIGIN, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;
const passwords = createPasswordService(4);
const input = {
  systemAdmin: { email: 'First.Admin@Hospital.example', displayName: 'First Admin', password: 'correct-horse-battery-1' },
  hrAdmin: { email: 'hr.lead@hospital.example', displayName: 'HR Lead', password: 'another-long-secret-22' },
  breakGlass: { email: 'root@hospital.example', displayName: 'Break-glass', password: 'sealed-envelope-halves-3' },
};

describeDb('bootstrap on an empty database (P6)', () => {
  let fresh: Awaited<ReturnType<typeof createFreshDatabase>>;
  let db: Db;
  let app: Express;

  beforeAll(async () => {
    fresh = await createFreshDatabase(TEST_URL!);
    db = fresh.db;
    app = testApp(db);
  }, 120_000);
  afterAll(async () => { await fresh?.drop(); });

  it('the migrated database is empty: no accounts, no hospital data', async () => {
    expect(await db.user.count()).toBe(0);
    expect(await db.department.count()).toBe(0);
    expect(await db.unit.count()).toBe(0);
    expect(await db.position.count()).toBe(0);
    expect(await db.credentialTemplate.count()).toBe(0);
    expect((await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: input.systemAdmin.email, password: input.systemAdmin.password })).status).toBe(401);
  });

  it('rejects weak passwords and shared e-mail addresses before touching the database', async () => {
    await expect(bootstrapAdministrators(db, { ...input, hrAdmin: { ...input.hrAdmin, password: 'short' } }, passwords)).rejects.toThrow();
    await expect(bootstrapAdministrators(db, { ...input, hrAdmin: { ...input.hrAdmin, email: input.systemAdmin.email } }, passwords)).rejects.toThrow(/own e-mail/);
    expect(await db.user.count()).toBe(0);
  });

  it('creates the System Admin, a hospital-wide HR Admin and the break-glass account, audited, and only once', async () => {
    const out = await bootstrapAdministrators(db, input, passwords);
    const users = await db.user.findMany({ include: { roleAssignments: true }, orderBy: { id: 'asc' } });
    expect(users.map((u) => [u.email, u.isBreakGlass, u.roleAssignments.map((r) => `${r.role}/${r.scopeType}`)])).toEqual([
      ['first.admin@hospital.example', false, ['SYSTEM_ADMIN/SYSTEM']],
      ['hr.lead@hospital.example', false, ['HR_ADMIN/SYSTEM']],
      ['root@hospital.example', true, []],
    ]);
    expect(users.every((u) => u.passwordHash.startsWith('$2') && !u.passwordHash.includes('correct'))).toBe(true);
    const audit = await db.auditEntry.findMany({ where: { action: 'SYSTEM_BOOTSTRAPPED' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.changes)).not.toMatch(/correct-horse|another-long|sealed-envelope/);

    await expect(bootstrapAdministrators(db, { ...input, systemAdmin: { ...input.systemAdmin, email: 'second@hospital.example' }, hrAdmin: { ...input.hrAdmin, email: 'hr2@hospital.example' }, breakGlass: undefined }, passwords))
      .rejects.toBeInstanceOf(BootstrapRefused);
    expect(await db.user.count()).toBe(3);
    expect(out.systemAdminId).toBe(users[0]!.id);
  });

  it('the bootstrapped HR Admin can sign in with the chosen password and holds the role', async () => {
    const login = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: input.hrAdmin.email, password: input.hrAdmin.password });
    expect(login.status).toBe(200);
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.body.effectiveRoles).toContain('HR_ADMIN');
  });
});
