// Loads the demo fixtures into an EMPTY, non-production database (P9):
// demo accounts, the hospital baseline (through the import's own apply step),
// then fictional employees, contracts, requirements and credentials.
// Everything is created inside one transaction and audited; the credentials
// pass the same tracking-data validation as the API.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyBaseline, parseBaseline } from '../../../src/modules/administration/baseline-import.js';
import { appendAudit } from '../../../src/lib/audit.js';
import { riyadhDate, toDbDate } from '../../../src/lib/dates.js';
import { toHijriIso } from '../../../src/lib/hijri.js';
import type { PasswordService } from '../../../src/lib/passwords.js';
import { PasswordSchema } from '../../../src/lib/passwords.js';
import type { Db } from '../../../src/lib/prisma.js';
import { presentTemplate, WITH_FIELDS } from '../../../src/modules/credentials/fields.js';
import { deriveStatus, readTrackingData } from '../../../src/modules/credentials/records.js';
import { refreshEligibility } from '../../../src/modules/eligibility/state.service.js';
import { DEMO_CONTRACTS, DEMO_CREDENTIALS, DEMO_EMPLOYEES, DEMO_REQUIREMENTS, DEMO_USERS } from './demo-data.js';

export const BASELINE_FILE = join(__dirname, '..', '..', '..', 'prisma', 'baseline', 'aigh-baseline.json');

export class FixtureRefused extends Error {}

/** Refuses production, a non-empty database, and database names not marked for development. */
export function assertFixtureTarget(env: { NODE_ENV?: string }, databaseUrl: string, allowDatabase?: string) {
  if (env.NODE_ENV === 'production') throw new FixtureRefused('Demo fixtures are never loaded with NODE_ENV=production.');
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!/(^|_)(dev|test|demo)(_|$)/.test(name) && name !== allowDatabase) {
    throw new FixtureRefused(`Database "${name}" is not marked _dev, _test or _demo. Pass --allow-database=${name} if it really is a development database.`);
  }
  return name;
}

export async function loadDemoFixtures(db: Db, password: string, passwords: PasswordService, today = riyadhDate()) {
  PasswordSchema.parse(password);
  const baseline = parseBaseline(JSON.parse(readFileSync(BASELINE_FILE, 'utf8')));
  const hash = await passwords.hash(password);

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('aigh_bootstrap'))`;
    if (await tx.user.count()) throw new FixtureRefused('The database already has accounts — demo fixtures load only into an empty database.');

    // Accounts first: the baseline import needs an actor.
    const users = new Map<string, number>();
    for (const u of DEMO_USERS) {
      const row = await tx.user.create({ data: { email: u.email, displayName: u.displayName, passwordHash: hash, isBreakGlass: 'isBreakGlass' in u && u.isBreakGlass } });
      users.set(u.email, row.id);
    }
    const adminId = users.get('admin@aigh.sa')!;
    const hrId = users.get('hr.admin@aigh.sa')!;

    await applyBaseline(tx, adminId, baseline, 'Development demo fixtures (not a production import)', null);
    const unitId = new Map((await tx.unit.findMany({ select: { id: true, code: true } })).map((u) => [u.code, u.id]));

    for (const u of DEMO_USERS) {
      if (!u.role || !u.scopeType) continue;
      await tx.roleAssignment.create({
        data: { userId: users.get(u.email)!, role: u.role, scopeType: u.scopeType, scopeIds: u.scopeUnits.map((c) => unitId.get(c)!), reason: 'Demo fixture assignment — not a production grant', grantedById: adminId },
      });
    }

    for (const { unitCode, hireDate, middleName, ...e } of DEMO_EMPLOYEES) {
      await tx.employee.create({ data: { ...e, middleName: middleName ?? null, fullName: '', unitId: unitId.get(unitCode)!, hireDate: toDbDate(hireDate) } });
    }
    const employeeId = new Map((await tx.employee.findMany({ select: { id: true, jobNumber: true } })).map((e) => [e.jobNumber, e.id]));
    for (const u of DEMO_USERS) {
      if ('employeeJobNumber' in u) await tx.user.update({ where: { id: users.get(u.email)! }, data: { employeeId: employeeId.get(u.employeeJobNumber)! } });
    }

    // Created by HR, approved by the System Admin — never the same person (D-30).
    for (const c of DEMO_CONTRACTS) {
      await tx.contract.create({
        data: {
          employeeId: employeeId.get(c.jobNumber)!, jobNumber: c.jobNumber, status: c.status,
          startDate: toDbDate(c.startDate), endDate: toDbDate(c.endDate), startDateHijri: toHijriIso(c.startDate), endDateHijri: toHijriIso(c.endDate),
          createdById: hrId, submittedById: hrId, approvedById: adminId, approvedAt: toDbDate(c.startDate),
        },
      });
    }

    const templateByCode = new Map((await tx.credentialTemplate.findMany({ include: WITH_FIELDS })).map((t) => [t.code, presentTemplate(t)]));
    for (const r of DEMO_REQUIREMENTS) {
      await tx.credentialRequirement.create({ data: { templateId: templateByCode.get(r.template)!.id, unitId: unitId.get(r.unit)!, positionCode: r.position } });
    }
    for (const c of DEMO_CREDENTIALS) {
      const tpl = templateByCode.get(c.template)!;
      const trackingData: Record<string, string> = { ...c.trackingData };
      if ('expiryGregorian' in c) trackingData.expiry_date = toHijriIso(c.expiryGregorian)!;
      const dates = readTrackingData(tpl, trackingData, {}); // same validation as POST /credentials
      await tx.credential.create({
        data: {
          employeeId: employeeId.get(c.jobNumber)!, templateId: tpl.id, trackingData,
          issueDate: dates.issueDate ? toDbDate(dates.issueDate) : null, expiryDate: dates.expiryDate ? toDbDate(dates.expiryDate) : null,
          expiryDateHijri: dates.expiryDate ? toHijriIso(dates.expiryDate) : null, // as POST /credentials stores it
          status: deriveStatus(dates.expiryDate ?? null, today),
        },
      });
    }

    for (const id of employeeId.values()) await refreshEligibility(tx, id, 'DEMO_FIXTURES');
    await appendAudit(tx, {
      actorUserId: null, action: 'DEMO_FIXTURES_LOADED', resource: 'system', priority: 'HIGH',
      changes: { employees: DEMO_EMPLOYEES.length, contracts: DEMO_CONTRACTS.length, credentials: DEMO_CREDENTIALS.length, users: DEMO_USERS.map((u) => u.email) },
    });
    return { users: users.size, employees: employeeId.size };
  }, { timeout: 180_000 });
}
