// Expiry scan (spec §7.1; N1, N3, N4; owner decision D-39). Daily at 06:00 Asia/Riyadh.
//
// Milestones: 90, 30, 14 and 7 days before the expiry / end date, and once it
// has passed ("0 days": the day after the last valid day — a credential is
// valid through its expiry date, a contract through its end date). Each run
// sends the milestone the record is in now, so a missed run or a record that
// enters late gets the current milestone, never a burst of old ones (N4).
//
// Routing (D-39, overrides N2's "HR at every notice"):
//   credentials — the nurse renews: employee at 90 and 30; + unit supervisor
//                 from 14; + scoped HR from 7 and at expiry.
//   contracts   — HR renews: employee and scoped HR from 90; + unit supervisor
//                 from 14 (the same cadence as credentials).
// A contract whose next period is already Approved or Active needs no reminder.
//
// Event key = record id + expiry date + milestone (N3), unique per recipient.
// Email waits for SMTP (not decided): rows are stored with emailStatus SKIPPED;
// unregistered employees get no in-app row.

import { addDays, daysBetween, dbDate, riyadhDate, toDbDate } from '../lib/dates.js';
import type { Db, DbClient } from '../lib/prisma.js';
import { recipientsForUnit } from '../modules/eligibility/state.service.js';

/** The first milestone is the renewal window (RENEWAL_WINDOW_DAYS, §5.2 "Subject to Renew"). */
export const MILESTONES = [90, 30, 14, 7] as const;
type Milestone = (typeof MILESTONES)[number] | 'expired';
type Audience = 'EMPLOYEE' | 'SUPERVISOR' | 'HR';

export const ROUTING: Record<'CREDENTIAL' | 'CONTRACT', Record<Milestone, Audience[]>> = {
  CREDENTIAL: {
    90: ['EMPLOYEE'], 30: ['EMPLOYEE'], 14: ['EMPLOYEE', 'SUPERVISOR'],
    7: ['EMPLOYEE', 'SUPERVISOR', 'HR'], expired: ['EMPLOYEE', 'SUPERVISOR', 'HR'],
  },
  CONTRACT: {
    90: ['EMPLOYEE', 'HR'], 30: ['EMPLOYEE', 'HR'], 14: ['EMPLOYEE', 'SUPERVISOR', 'HR'],
    7: ['EMPLOYEE', 'SUPERVISOR', 'HR'], expired: ['EMPLOYEE', 'SUPERVISOR', 'HR'],
  },
};

/** The milestone a record is in, `daysLeft` days before its last valid day (0 = last day). */
export function milestoneFor(daysLeft: number): Milestone | null {
  if (daysLeft < 0) return 'expired';
  const within = MILESTONES.filter((m) => daysLeft <= m);
  return within.length ? within[within.length - 1]! : null;
}

type Notice = {
  kind: 'CREDENTIAL' | 'CONTRACT'; milestone: Milestone; employeeId: number; unitId: number | null; eventKey: string;
  title: string; message: string; titleAr: string; messageAr: string;
};

async function deliver(tx: DbClient, n: Notice, now: Date) {
  const audience = ROUTING[n.kind][n.milestone];
  const ids: number[] = [];
  if (audience.includes('EMPLOYEE')) {
    const own = await tx.user.findFirst({ where: { employeeId: n.employeeId, isActive: true }, select: { id: true } });
    if (own) ids.push(own.id);
  }
  if (audience.includes('SUPERVISOR')) ids.push(...(await recipientsForUnit(tx, 'SUPERVISOR', n.unitId, now)));
  if (audience.includes('HR')) ids.push(...(await recipientsForUnit(tx, 'HR_ADMIN', n.unitId, now)));
  const priority = n.milestone === 90 || n.milestone === 30 ? 'MEDIUM' as const : 'HIGH' as const;
  const { eventKey, title, message, titleAr, messageAr, employeeId } = n;
  const r = await tx.notification.createMany({
    data: [...new Set(ids)].map((recipientId) => ({ recipientId, employeeId, type: n.kind, priority, eventKey, title, message, titleAr, messageAr })),
    skipDuplicates: true,
  });
  return r.count;
}

export async function expiryScan(db: Db, now = new Date()) {
  const today = riyadhDate(now);
  const horizon = toDbDate(addDays(today, MILESTONES[0]));
  const summary = { contracts: 0, contractsEnded: 0, credentialsExpiring: 0, credentialsExpired: 0, notificationsCreated: 0 };
  const employee = { select: { unitId: true, jobNumber: true, fullName: true } } as const;

  const contracts = await db.contract.findMany({
    where: { status: { in: ['Approved', 'Active', 'Expired'] }, endDate: { lte: horizon }, employee: { deletedAt: null } },
    select: {
      id: true, employeeId: true, endDate: true, status: true,
      employee: { select: { ...employee.select, contracts: { where: { status: { in: ['Approved', 'Active'] } }, select: { id: true, endDate: true } } } },
    },
  });
  const credentials = await db.credential.findMany({
    where: {
      OR: [
        { status: { in: ['Valid', 'ExpiringSoon'] }, expiryDate: { gte: toDbDate(today), lte: horizon } },
        { status: { notIn: ['Suspended', 'Revoked', 'PendingVerification'] }, expiryDate: { lt: toDbDate(today) } },
      ],
      employee: { deletedAt: null },
    },
    select: { id: true, employeeId: true, expiryDate: true, template: { select: { name: true } }, employee },
  });

  const notices: Notice[] = [];
  for (const c of contracts) {
    const end = dbDate(c.endDate);
    // The next period is already secured: nothing to remind.
    if (c.employee.contracts.some((o) => o.id !== c.id && dbDate(o.endDate) > end)) continue;
    const left = daysBetween(today, end);
    const milestone = milestoneFor(left);
    // An Expired status only matters once the end date has passed; Approved/Active past their end are expired too.
    if (!milestone || (c.status === 'Expired' && milestone !== 'expired')) continue;
    const who = `${c.employee.jobNumber} ${c.employee.fullName}`;
    if (milestone === 'expired') {
      summary.contractsEnded += 1;
      notices.push({
        kind: 'CONTRACT', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `contract:${c.id}:${end}:expired`,
        title: 'Contract ended', message: `${who}: the contract ended on ${end} and no next period is approved.`,
        titleAr: 'انتهى العقد', messageAr: `${who}: انتهى العقد في ${end} ولا توجد فترة تالية معتمدة.`,
      });
    } else {
      summary.contracts += 1;
      notices.push({
        kind: 'CONTRACT', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `contract:${c.id}:${end}:within-${milestone}`,
        title: 'Contract ending soon', message: `${who}: the contract ends on ${end} (${left} days left).`,
        titleAr: 'العقد يقترب من الانتهاء', messageAr: `${who}: ينتهي العقد في ${end} (متبقٍ ${left} يومًا).`,
      });
    }
  }
  for (const c of credentials) {
    const expiry = dbDate(c.expiryDate!);
    const left = daysBetween(today, expiry);
    const milestone = milestoneFor(left);
    if (!milestone) continue;
    const who = `${c.employee.jobNumber} ${c.employee.fullName}`;
    if (milestone === 'expired') {
      summary.credentialsExpired += 1;
      notices.push({
        kind: 'CREDENTIAL', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `credential:${c.id}:${expiry}:expired`,
        title: 'Credential expired', message: `${who}: ${c.template.name} expired on ${expiry}.`,
        titleAr: 'انتهت صلاحية شهادة', messageAr: `${who}: انتهت صلاحية ${c.template.name} في ${expiry}.`,
      });
    } else {
      summary.credentialsExpiring += 1;
      notices.push({
        kind: 'CREDENTIAL', milestone, employeeId: c.employeeId, unitId: c.employee.unitId, eventKey: `credential:${c.id}:${expiry}:within-${milestone}`,
        title: 'Credential expiring soon', message: `${who}: ${c.template.name} expires on ${expiry} (${left} days left). Start the renewal now.`,
        titleAr: 'شهادة تقترب من الانتهاء', messageAr: `${who}: تنتهي ${c.template.name} في ${expiry} (متبقٍ ${left} يومًا). ابدأ التجديد الآن.`,
      });
    }
  }
  for (const n of notices) summary.notificationsCreated += await deliver(db, n, now);
  return summary;
}
