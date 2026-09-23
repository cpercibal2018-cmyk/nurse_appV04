// Expiry scan (spec §7.1; N1–N4). Daily at 06:00 Asia/Riyadh.
//   - Contracts: Approved/Active ending within 90 days.
//   - Credentials: expiring within 60 days, and already expired.
// Recipients: the employee's own account and the scoped active HR admins (N2).
// Event key = record id + expiry date + milestone (N3); window queries catch up
// after missed runs (N4). Milestones are not listed in the spec (REQUIREMENT NOT
// ESTABLISHED): V04 sends one notice when an item enters its window and one when
// a credential has expired. Email waits for SMTP (not decided): rows are stored
// with emailStatus SKIPPED; unregistered employees get no in-app row.

import { addDays, dbDate, riyadhDate, toDbDate } from '../lib/dates.js';
import type { Db, DbClient } from '../lib/prisma.js';
import { hrRecipientsForUnit } from '../modules/eligibility/state.service.js';

export const CONTRACT_WINDOW_DAYS = 90;
export const CREDENTIAL_WINDOW_DAYS = 60;

type Notice = { employeeId: number; unitId: number | null; eventKey: string; type: 'CONTRACT' | 'CREDENTIAL'; priority: 'MEDIUM' | 'HIGH'; title: string; message: string; titleAr: string; messageAr: string };

async function deliver(tx: DbClient, n: Notice, now: Date) {
  const own = await tx.user.findFirst({ where: { employeeId: n.employeeId, isActive: true }, select: { id: true } });
  const recipients = [...new Set([...(own ? [own.id] : []), ...(await hrRecipientsForUnit(tx, n.unitId, now))])];
  const { unitId: _u, ...fields } = n;
  const r = await tx.notification.createMany({ data: recipients.map((recipientId) => ({ recipientId, ...fields })), skipDuplicates: true });
  return r.count;
}

export async function expiryScan(db: Db, now = new Date()) {
  const today = riyadhDate(now);
  const summary = { contracts: 0, credentialsExpiring: 0, credentialsExpired: 0, notificationsCreated: 0 };
  const employee = { select: { unitId: true, jobNumber: true, fullName: true } } as const;

  const contracts = await db.contract.findMany({
    where: { status: { in: ['Approved', 'Active'] }, endDate: { gte: toDbDate(today), lte: toDbDate(addDays(today, CONTRACT_WINDOW_DAYS)) }, employee: { deletedAt: null } },
    select: { id: true, employeeId: true, endDate: true, employee },
  });
  const expiring = await db.credential.findMany({
    where: { status: { in: ['Valid', 'ExpiringSoon'] }, expiryDate: { gte: toDbDate(today), lte: toDbDate(addDays(today, CREDENTIAL_WINDOW_DAYS)) }, employee: { deletedAt: null } },
    select: { id: true, employeeId: true, expiryDate: true, template: { select: { name: true } }, employee },
  });
  const expired = await db.credential.findMany({
    where: { status: { notIn: ['Suspended', 'Revoked', 'PendingVerification'] }, expiryDate: { lt: toDbDate(today) }, employee: { deletedAt: null } },
    select: { id: true, employeeId: true, expiryDate: true, template: { select: { name: true } }, employee },
  });

  const notices: Notice[] = [
    ...contracts.map((c) => ({
      employeeId: c.employeeId, unitId: c.employee.unitId, type: 'CONTRACT' as const, priority: 'MEDIUM' as const,
      eventKey: `contract:${c.id}:${dbDate(c.endDate)}:within-${CONTRACT_WINDOW_DAYS}`,
      title: 'Contract ending soon', message: `${c.employee.jobNumber} ${c.employee.fullName}: the contract ends on ${dbDate(c.endDate)}.`,
      titleAr: 'العقد يقترب من الانتهاء', messageAr: `${c.employee.jobNumber} ${c.employee.fullName}: ينتهي العقد في ${dbDate(c.endDate)}.`,
    })),
    ...expiring.map((c) => ({
      employeeId: c.employeeId, unitId: c.employee.unitId, type: 'CREDENTIAL' as const, priority: 'MEDIUM' as const,
      eventKey: `credential:${c.id}:${dbDate(c.expiryDate!)}:within-${CREDENTIAL_WINDOW_DAYS}`,
      title: 'Credential expiring soon', message: `${c.employee.jobNumber} ${c.employee.fullName}: ${c.template.name} expires on ${dbDate(c.expiryDate!)}. Start the renewal now.`,
      titleAr: 'شهادة تقترب من الانتهاء', messageAr: `${c.employee.jobNumber} ${c.employee.fullName}: تنتهي ${c.template.name} في ${dbDate(c.expiryDate!)}. ابدأ التجديد الآن.`,
    })),
    ...expired.map((c) => ({
      employeeId: c.employeeId, unitId: c.employee.unitId, type: 'CREDENTIAL' as const, priority: 'HIGH' as const,
      eventKey: `credential:${c.id}:${dbDate(c.expiryDate!)}:expired`,
      title: 'Credential expired', message: `${c.employee.jobNumber} ${c.employee.fullName}: ${c.template.name} expired on ${dbDate(c.expiryDate!)}.`,
      titleAr: 'انتهت صلاحية شهادة', messageAr: `${c.employee.jobNumber} ${c.employee.fullName}: انتهت صلاحية ${c.template.name} في ${dbDate(c.expiryDate!)}.`,
    })),
  ];
  summary.contracts = contracts.length;
  summary.credentialsExpiring = expiring.length;
  summary.credentialsExpired = expired.length;
  for (const n of notices) summary.notificationsCreated += await deliver(db, n, now);
  return summary;
}
