// The backend core against the real test database: health, and translation of
// real database rule violations into stable, client-safe error codes.

import 'dotenv/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPrisma, type Db, Prisma } from '../src/lib/prisma.js';
import { fromPrismaError } from '../src/middleware/errors.js';

const url = process.env.TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('backend core (database)', () => {
  let db: Db;
  beforeAll(() => { db = createPrisma(url!); });
  afterAll(async () => { await db.$disconnect(); });

  it('health reports the database up', async () => {
    const app = createApp({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: url! }), db });
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  /** Runs `write` and returns the Prisma error it raised (always rolled back). */
  async function capture(write: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    let caught: unknown;
    await db.$transaction(async (tx) => {
      try { await write(tx); } catch (e) { caught = e; }
      throw new Error('rollback');
    }).catch(() => undefined);
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    return fromPrismaError(caught as Prisma.PrismaClientKnownRequestError);
  }

  it('maps a real contract overlap (exclusion constraint) to CONTRACT_PERIOD_OVERLAP', async () => {
    const mapped = await capture(async (tx) => {
      const dept = await tx.department.create({ data: { code: `AC${Date.now()}`, name: 'd' } });
      await tx.position.upsert({ where: { code: 'SN' }, update: {}, create: { code: 'SN', title: 'Staff Nurse', tier: 'Clinical', isSchedulable: true } });
      const unit = await tx.unit.create({ data: { code: `ACU${Date.now()}`, name: 'u', departmentId: dept.id } });
      const emp = await tx.employee.create({ data: { jobNumber: `AC${Date.now()}`, firstName: 'A', lastName: 'B', fullName: 'x', contactEmail: 'a@x.sa', positionCode: 'SN', unitId: unit.id } });
      const base = { employeeId: emp.id, jobNumber: emp.jobNumber, status: 'Active' as const };
      await tx.contract.create({ data: { ...base, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') } });
      await tx.contract.create({ data: { ...base, startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31') } });
    });
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe('CONTRACT_PERIOD_OVERLAP');
  });

  it('maps an unnamed check violation generically without leaking the constraint', async () => {
    const mapped = await capture(async (tx) => {
      const dept = await tx.department.create({ data: { code: `AD${Date.now()}`, name: 'd' } });
      await tx.coverageTarget.create({ data: { unitId: (await tx.unit.create({ data: { code: `ADU${Date.now()}`, name: 'u', departmentId: dept.id } })).id, shiftType: 'Morning', minimumStaff: -1 } });
    });
    expect(mapped.status).toBe(422);
    expect(JSON.stringify(mapped.toBody())).not.toMatch(/chk_|coverage_targets/);
  });

  it('maps a missing foreign key to RELATED_RECORD_MISSING', async () => {
    const mapped = await capture((tx) => tx.unit.create({ data: { code: `AF${Date.now()}`, name: 'u', departmentId: 2_000_000_000 } }));
    expect(mapped.code).toBe('RELATED_RECORD_MISSING');
  });
});
