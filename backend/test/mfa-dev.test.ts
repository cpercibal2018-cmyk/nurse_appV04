// Development switch for two-factor sign-in (cli/mfa-dev.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/lib/prisma.js';
import { removeAuthenticators, setRequiredRoles } from '../src/cli/mfa-dev.js';
import { makeUser, openDb, TEST_URL } from './helpers.js';

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
