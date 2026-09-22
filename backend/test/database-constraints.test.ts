// Database-level business rules (rule IDs: docs/FEATURE_MASTER_INVENTORY.md §15).
// Runs against the migrated database in TEST_DATABASE_URL; every case runs in a
// transaction that is rolled back, so the database is left unchanged.

import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrisma, type Db, Prisma } from '../src/lib/prisma.js';
import { appendAudit, findChainBreaks } from '../src/lib/audit.js';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

class Rollback extends Error {}

describeDb('database constraints', () => {
  let db: Db;

  beforeAll(() => { db = createPrisma(url!); });
  afterAll(async () => { await db.$disconnect(); });

  /** Runs `fn` in a transaction and always rolls it back. */
  async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
    await expect(db.$transaction(async (tx) => { await fn(tx); throw new Rollback(); }))
      .rejects.toBeInstanceOf(Rollback);
  }

  async function fixture(tx: Prisma.TransactionClient) {
    const dept = await tx.department.create({ data: { code: `T${Date.now()}`, name: 'Test dept' } });
    const unit = await tx.unit.create({ data: { code: `TU${Date.now()}`, name: 'Test unit', departmentId: dept.id, bedCount: 10 } });
    await tx.position.upsert({ where: { code: 'SN' }, update: {}, create: { code: 'SN', title: 'Staff Nurse', tier: 'Clinical', isSchedulable: true } });
    const emp = await tx.employee.create({
      data: { jobNumber: `J${Date.now()}`, firstName: 'Test', lastName: 'Nurse', fullName: 'x', contactEmail: 't@x.sa', positionCode: 'SN', unitId: unit.id },
    });
    return { dept, unit, emp };
  }

  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it('C4: rejects overlapping Approved/Active contracts, allows an overlapping Draft', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      const base = { employeeId: emp.id, jobNumber: emp.jobNumber };
      await tx.contract.create({ data: { ...base, status: 'Active', startDate: day('2026-01-01'), endDate: day('2026-12-31') } });
      await tx.contract.create({ data: { ...base, status: 'Draft', startDate: day('2026-06-01'), endDate: day('2027-05-31') } });
      await expect(tx.$executeRaw`SAVEPOINT s1`).resolves.toBeDefined();
      await expect(tx.contract.create({ data: { ...base, status: 'Approved', startDate: day('2026-12-31'), endDate: day('2027-12-30') } }))
        .rejects.toThrow(/no_overlapping_active_contracts|exclusion|conflicting key/i);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      // Inclusive dates: the next period may start the day after the previous end.
      await tx.contract.create({ data: { ...base, status: 'Approved', startDate: day('2027-01-01'), endDate: day('2027-12-31') } });
    });
  });

  it('C5: rejects a contract whose end is not after its start', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      await expect(tx.contract.create({ data: { employeeId: emp.id, jobNumber: emp.jobNumber, startDate: day('2026-01-01'), endDate: day('2026-01-01') } }))
        .rejects.toThrow(/chk_contracts_dates|check constraint/i);
    });
  });

  it('E1: job numbers are unique case-insensitively and have no format rule', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      await tx.employee.create({ data: { jobNumber: 'AIGH1002', firstName: 'A', lastName: 'B', fullName: 'x', contactEmail: 'a@x.sa', positionCode: 'SN' } });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.employee.create({ data: { jobNumber: emp.jobNumber.toLowerCase(), firstName: 'C', lastName: 'D', fullName: 'x', contactEmail: 'c@x.sa', positionCode: 'SN' } }))
        .rejects.toThrow(/unique|employees_job_number/i);
    });
  });

  it('E3: full name is derived from first + middle + last, ignoring the supplied value', async () => {
    await inRollback(async (tx) => {
      await fixture(tx); // ensures position SN exists
      const e = await tx.employee.create({ data: { jobNumber: 'FN1', firstName: ' Fatima ', lastName: 'Zahra', fullName: 'WRONG', contactEmail: 'f@x.sa', positionCode: 'SN' } });
      expect(e.fullName).toBe('Fatima Zahra');
      const u = await tx.employee.update({ where: { id: e.id }, data: { middleName: 'Al' } });
      expect(u.fullName).toBe('Fatima Al Zahra');
    });
  });

  it('W4: bed count must be 0–500', async () => {
    await inRollback(async (tx) => {
      const { unit } = await fixture(tx);
      await expect(tx.unit.update({ where: { id: unit.id }, data: { bedCount: 501 } })).rejects.toThrow(/chk_units_bed_count|check constraint/i);
    });
  });

  it('L9: waivers are limited to 72 hours and must expire in the future', async () => {
    await inRollback(async (tx) => {
      const { emp } = await fixture(tx);
      const tpl = await tx.credentialTemplate.create({ data: { code: `TT${Date.now()}`, name: 'T', categoryCode: (await tx.credentialCategory.upsert({ where: { code: 'LICENSURE' }, update: {}, create: { code: 'LICENSURE', name: 'Licensure' } })).code } });
      const user = await tx.user.create({ data: { email: `w${Date.now()}@x.sa`, displayName: 'W', passwordHash: 'x' } });
      const base = { employeeId: emp.id, templateId: tpl.id, waivedById: user.id, reason: 'staffing emergency', createdAt: new Date('2026-09-23T00:00:00Z') };
      await tx.credentialWaiver.create({ data: { ...base, expiresAt: new Date('2026-09-26T00:00:00Z') } }); // exactly 72 h
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.credentialWaiver.create({ data: { ...base, expiresAt: new Date('2026-09-26T00:00:01Z') } }))
        .rejects.toThrow(/chk_waiver_max_window|check constraint/i);
    });
  });

  it('S1: a nurse cannot hold the same shift twice on one date, even in two units', async () => {
    await inRollback(async (tx) => {
      const { emp, unit, dept } = await fixture(tx);
      const unit2 = await tx.unit.create({ data: { code: `TU2${Date.now()}`, name: 'Second', departmentId: dept.id } });
      const slot = { employeeId: emp.id, shiftDate: day('2026-10-01'), shiftType: 'Night' as const };
      const first = await tx.shiftAssignment.create({ data: { ...slot, unitId: unit.id } });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.shiftAssignment.create({ data: { ...slot, unitId: unit2.id } })).rejects.toThrow(/unique|shift_assignments_employee_slot/i);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      // A cancelled assignment frees the slot.
      await tx.shiftAssignment.update({ where: { id: first.id }, data: { status: 'Cancelled' } });
      await tx.shiftAssignment.create({ data: { ...slot, unitId: unit2.id } });
    });
  });

  it('R3/R7: SYSTEM scope has no ids, and one active assignment per user + role + scope type', async () => {
    await inRollback(async (tx) => {
      const u = await tx.user.create({ data: { email: `r${Date.now()}@x.sa`, displayName: 'R', passwordHash: 'x' } });
      const base = { userId: u.id, grantedById: u.id, reason: 'test grant with a long reason' };
      await expect(tx.roleAssignment.create({ data: { ...base, role: 'HR_ADMIN', scopeType: 'SYSTEM', scopeIds: [1] } }))
        .rejects.toThrow(/chk_role_assignments_scope|check constraint/i);
    });
    await inRollback(async (tx) => {
      const u = await tx.user.create({ data: { email: `r2${Date.now()}@x.sa`, displayName: 'R', passwordHash: 'x' } });
      const base = { userId: u.id, grantedById: u.id, reason: 'test grant with a long reason', role: 'SUPERVISOR' as const, scopeType: 'UNIT' as const };
      const first = await tx.roleAssignment.create({ data: { ...base, scopeIds: [1] } });
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.roleAssignment.create({ data: { ...base, scopeIds: [2] } })).rejects.toThrow(/unique|role_assignments_active/i);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      await tx.roleAssignment.update({ where: { id: first.id }, data: { revokedAt: new Date(), revokedById: u.id } });
      await tx.roleAssignment.create({ data: { ...base, scopeIds: [2] } });
    });
  });

  it('A2/A3: audit rows chain, verify, and cannot be updated or deleted', async () => {
    await inRollback(async (tx) => {
      const a = await appendAudit(tx, { actorUserId: null, action: 'TEST_A', resource: 'test', changes: { n: 1 } });
      const b = await appendAudit(tx, { actorUserId: null, action: 'TEST_B', resource: 'test', priority: 'HIGH' });
      const rows = await tx.auditEntry.findMany({ where: { id: { in: [a, b] } }, orderBy: { id: 'asc' } });
      expect(rows[1]!.previousHash).toBe(rows[0]!.hash);
      expect(await findChainBreaks(tx)).toEqual([]);
      await tx.$executeRaw`SAVEPOINT s1`;
      await expect(tx.$executeRaw`UPDATE audit_entries SET action = 'TAMPERED' WHERE id = ${a}`).rejects.toThrow(/append-only/);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
      await expect(tx.$executeRaw`DELETE FROM audit_entries WHERE id = ${a}`).rejects.toThrow(/append-only/);
    });
  });

  it('A3: the verification view detects a tampered row', async () => {
    await inRollback(async (tx) => {
      const id = await appendAudit(tx, { actorUserId: null, action: 'TEST_TAMPER', resource: 'test' });
      // Simulate tampering by a privileged actor who disables the guard trigger.
      await tx.$executeRaw`ALTER TABLE audit_entries DISABLE TRIGGER trg_audit_entries_append_only`;
      await tx.$executeRaw`UPDATE audit_entries SET changes = '{"forged":true}' WHERE id = ${id}`;
      expect(await findChainBreaks(tx)).toContainEqual({ id, reason: 'CONTENT_MISMATCH' });
    });
  });
});
