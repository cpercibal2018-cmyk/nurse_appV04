// Development switch for two-factor sign-in (cli/mfa-dev.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Db } from '../src/lib/prisma.js';
import { findAccount, removeAuthenticators, setAccountExemption, setRequiredRoles } from '../src/cli/mfa-dev.js';
import { createMfa } from '../src/modules/auth/mfa.js';
import { createSecretBox, mfaKey } from '../src/lib/secret-box.js';
import { makeUser, openDb, ORIGIN, PASSWORD, TEST_URL, testApp, testEnv } from './helpers.js';

describe('setRequiredRoles', () => {
  it('replaces the line and keeps every other line and the line endings', () => {
    const before = 'NODE_ENV=development\r\nMFA_REQUIRED_ROLES=SYSTEM_ADMIN,HR_ADMIN\r\nJWT_SECRET=x\r\n';
    expect(setRequiredRoles(before, ['HR_ADMIN'])).toBe('NODE_ENV=development\r\nMFA_REQUIRED_ROLES=HR_ADMIN\r\nJWT_SECRET=x\r\n');
  });
  it('appends the line when missing, and writes "none" for no roles', () => {
    expect(setRequiredRoles('A=1\n', [])).toBe('A=1\nMFA_REQUIRED_ROLES=none\n');
    expect(setRequiredRoles('A=1', ['SYSTEM_ADMIN'])).toBe('A=1\nMFA_REQUIRED_ROLES=SYSTEM_ADMIN\n');
  });
});

const describeDb = TEST_URL ? describe : describe.skip;

describeDb('removeAuthenticators', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });

  it('removes the authenticator and recovery codes, audited; accounts without one are skipped', async () => {
    const withOne = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    const without = await makeUser(db, { roles: [{ role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM' }] });
    await db.mfaFactor.create({ data: { userId: withOne.id, secretEnc: 'v1:x:y:z', confirmedAt: new Date() } });
    await db.mfaRecoveryCode.create({ data: { userId: withOne.id, codeHash: 'h' } });
    expect(await removeAuthenticators(db, [withOne.id, without.id])).toBe(1);
    expect(await db.mfaFactor.count({ where: { userId: withOne.id } })).toBe(0);
    expect(await db.mfaRecoveryCode.count({ where: { userId: withOne.id } })).toBe(0);
    const audit = await db.auditEntry.findFirstOrThrow({ where: { action: 'MFA_RESET', resourceId: String(withOne.id) } });
    expect(audit.changes).toMatchObject({ wasConfirmed: true, via: 'cli mfa off (development)' });
    expect(await db.auditEntry.count({ where: { action: 'MFA_RESET', resourceId: String(without.id) } })).toBe(0);
  });
});

describeDb('one account exempt from two-factor (D-68, development only)', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });

  const ON = { MFA_REQUIRED_ROLES: 'SYSTEM_ADMIN,HR_ADMIN,SUPERVISOR' };
  const login = (app: ReturnType<typeof testApp>, email: string) => request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password: PASSWORD });

  it('finds an account by e-mail in any case, or by id', async () => {
    const u = await makeUser(db);
    expect((await findAccount(db, u.email.toUpperCase()))?.id).toBe(u.id);
    expect((await findAccount(db, String(u.id)))?.email).toBe(u.email);
    expect(await findAccount(db, 'nobody@nowhere.example')).toBeNull();
  });

  it('off: its authenticator is removed and it signs in with the password only, whatever its role; on: set-up is asked again', async () => {
    const app = testApp(db, ON);
    const hr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    await db.mfaFactor.create({ data: { userId: hr.id, secretEnc: 'v1:x:y:z', confirmedAt: new Date() } });
    expect((await login(app, hr.email)).body.mfa.step).toBe('VERIFY');

    expect(await setAccountExemption(db, hr.id, true)).toEqual({ changed: true, authenticatorRemoved: true });
    const res = await login(app, hr.email);
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String)); // no second step
    expect(await db.mfaFactor.count({ where: { userId: hr.id } })).toBe(0);
    expect(await db.auditEntry.findFirst({ where: { action: 'MFA_DEV_EXEMPTED', resourceId: String(hr.id) } })).toMatchObject({ priority: 'HIGH' });
    expect(await setAccountExemption(db, hr.id, true)).toEqual({ changed: false, authenticatorRemoved: false });

    expect((await setAccountExemption(db, hr.id, false)).changed).toBe(true);
    expect((await login(app, hr.email)).body.mfa.step).toBe('ENROLL');
    expect(await db.auditEntry.count({ where: { action: 'MFA_DEV_EXEMPTION_CLEARED', resourceId: String(hr.id) } })).toBe(1);
  });

  it('production ignores the exemption', async () => {
    const hr = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    await setAccountExemption(db, hr.id, true);
    const dev = testEnv(ON);
    const prod = { ...dev, NODE_ENV: 'production' as const };
    const box = createSecretBox(mfaKey(dev));
    expect(await createMfa(db, dev, box).stepFor(db, { id: hr.id, isBreakGlass: false })).toBeNull();
    expect(await createMfa(db, prod, box).stepFor(db, { id: hr.id, isBreakGlass: false })).toBe('ENROLL');
  });
});
