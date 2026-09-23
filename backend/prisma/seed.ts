// The only seed. Idempotent: rows that already exist are left untouched, so
// HR changes to the baseline survive a re-run.
//
//   npx prisma db seed                      reference data (organisation, positions, credential catalog)
//   SEED_DEMO=true SEED_DEMO_PASSWORD=… …   plus demo employees, contracts, credentials and users
//
// Demo data is refused when NODE_ENV=production.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PasswordSchema } from '../src/lib/passwords.js';
import { refreshEligibility } from '../src/modules/eligibility/state.service.js';
import { createPrisma, type Db } from '../src/lib/prisma.js';
import { appendAudit } from '../src/lib/audit.js';
import { toHijriIso } from '../src/lib/hijri.js';
import { fieldRows } from '../src/modules/credentials/fields.js';
import { DEPARTMENTS, UNITS } from './seed-data/organisation.js';
import { POSITIONS } from './seed-data/positions.js';
import { CREDENTIAL_CATEGORIES, CREDENTIAL_TEMPLATES } from './seed-data/credential-catalog.js';
import {
  DEMO_CONTRACTS, DEMO_CREDENTIALS, DEMO_EMPLOYEES, DEMO_REQUIREMENTS, DEMO_USERS,
} from './seed-data/demo.js';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function seedReference(db: Db) {
  for (const d of DEPARTMENTS) {
    await db.department.upsert({ where: { code: d.code }, update: {}, create: d });
  }
  const deptId = new Map((await db.department.findMany()).map((d) => [d.code, d.id]));

  for (const { departmentCode, ...u } of UNITS) {
    const existing = await db.unit.findUnique({ where: { code: u.code } });
    if (existing) continue;
    await db.$transaction(async (tx) => {
      const unit = await tx.unit.create({ data: { ...u, departmentId: deptId.get(departmentCode)! } });
      await tx.bedCapacityLog.create({
        data: { unitId: unit.id, previousCount: 0, newCount: unit.bedCount, reason: 'Initial seed from Hospital Master Unit Directory' },
      });
    });
  }

  for (const p of POSITIONS) {
    await db.position.upsert({ where: { code: p.code }, update: {}, create: p });
  }
  for (const c of CREDENTIAL_CATEGORIES) {
    await db.credentialCategory.upsert({ where: { code: c.code }, update: {}, create: c });
  }
  for (const t of CREDENTIAL_TEMPLATES) {
    if (await db.credentialTemplate.findUnique({ where: { code: t.code }, select: { id: true } })) continue;
    const { fieldDefs, ...columns } = t;
    const created = await db.credentialTemplate.create({ data: columns });
    await db.credentialTemplateField.createMany({ data: fieldRows(created.id, fieldDefs) });
  }
}

async function seedDemo(db: Db, password: string) {
  const unitId = new Map((await db.unit.findMany()).map((u) => [u.code, u.id]));
  const templateId = new Map((await db.credentialTemplate.findMany()).map((t) => [t.code, t.id]));

  for (const { unitCode, hireDate, middleName, ...e } of DEMO_EMPLOYEES) {
    await db.employee.upsert({
      where: { jobNumber: e.jobNumber },
      update: {},
      create: {
        ...e,
        middleName: middleName ?? null,
        fullName: [e.firstName, middleName, e.lastName].filter(Boolean).join(' '), // recomputed by trigger
        unitId: unitId.get(unitCode)!,
        hireDate: day(hireDate),
      },
    });
  }
  const employeeId = new Map((await db.employee.findMany()).map((e) => [e.jobNumber, e.id]));

  for (const c of DEMO_CONTRACTS) {
    const id = employeeId.get(c.jobNumber)!;
    if (await db.contract.count({ where: { employeeId: id } })) continue;
    await db.contract.create({
      data: {
        employeeId: id, jobNumber: c.jobNumber, status: c.status,
        startDate: day(c.startDate), endDate: day(c.endDate),
        startDateHijri: toHijriIso(c.startDate), endDateHijri: toHijriIso(c.endDate),
      },
    });
  }

  for (const r of DEMO_REQUIREMENTS) {
    const data = { templateId: templateId.get(r.template)!, unitId: unitId.get(r.unit)!, positionCode: r.position };
    if (await db.credentialRequirement.count({ where: data })) continue;
    await db.credentialRequirement.create({ data });
  }

  for (const c of DEMO_CREDENTIALS) {
    const data = { employeeId: employeeId.get(c.jobNumber)!, templateId: templateId.get(c.template)! };
    if (await db.credential.count({ where: data })) continue;
    await db.credential.create({
      data: {
        ...data, status: c.status, trackingData: c.trackingData,
        issueDate: day(c.issueDate), expiryDate: day(c.expiryDate),
      },
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const users = new Map<string, number>();
  for (const u of DEMO_USERS) {
    const linked = 'employeeJobNumber' in u ? employeeId.get(u.employeeJobNumber) ?? null : null;
    const user = await db.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, displayName: u.displayName, passwordHash, employeeId: linked, isBreakGlass: 'isBreakGlass' in u && u.isBreakGlass },
    });
    users.set(u.email, user.id);
  }

  // Bootstrap grants. The first SYSTEM_ADMIN necessarily grants itself — the one
  // place rule R2 (no self-grant) cannot apply; the audit row records it as a seed.
  const grantor = users.get('admin@aigh.sa')!;
  for (const u of DEMO_USERS) {
    if (!u.role || !u.scopeType) continue;
    const userId = users.get(u.email)!;
    if (await db.roleAssignment.count({ where: { userId, role: u.role, revokedAt: null } })) continue;
    await db.roleAssignment.create({
      data: {
        userId, role: u.role, scopeType: u.scopeType,
        scopeIds: u.scopeUnits.map((code) => unitId.get(code)!),
        reason: 'Demo seed bootstrap assignment — not a production grant',
        grantedById: grantor,
      },
    });
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const demo = process.env.SEED_DEMO === 'true';
  if (demo && process.env.NODE_ENV === 'production') throw new Error('Refusing to load demo data in production');
  const demoPassword = process.env.SEED_DEMO_PASSWORD ?? '';
  // Same rule as every other password (spec §3.2: 12–72 characters).
  if (demo && !PasswordSchema.safeParse(demoPassword).success) {
    throw new Error('SEED_DEMO_PASSWORD (12–72 characters) is required with SEED_DEMO=true');
  }

  const db = createPrisma(url);
  try {
    await seedReference(db);
    if (demo) {
      await seedDemo(db, demoPassword);
      // Materialize eligibility for every demo nurse with the one engine (spec §6.1).
      const emps = await db.employee.findMany({ where: { deletedAt: null }, select: { id: true } });
      for (const e of emps) await db.$transaction((tx) => refreshEligibility(tx, e.id, 'SEED'));
    }
    await appendAudit(db, {
      actorUserId: null, action: 'SEED_APPLIED', resource: 'system',
      changes: { reference: true, demo },
    });
    const counts = {
      departments: await db.department.count(), units: await db.unit.count(),
      beds: (await db.unit.aggregate({ _sum: { bedCount: true } }))._sum.bedCount,
      positions: await db.position.count(), templates: await db.credentialTemplate.count(),
      employees: await db.employee.count(), contracts: await db.contract.count(),
      credentials: await db.credential.count(), users: await db.user.count(),
    };
    console.log('Seed complete:', counts);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
