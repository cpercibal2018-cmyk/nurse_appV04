// Data-subject rights (spec §8.3.3, PDPL; decision D-55).
//
// An employee asks, from their own account, to see (ACCESS), take away
// (PORTABILITY), correct (RECTIFICATION) or erase (ERASURE) their personal
// data; HR can also log a request received on paper or by e-mail. HR within
// scope works the queue:
// - ACCESS / PORTABILITY: approval completes the request and makes the
//   personal-data package downloadable (by the employee and by HR) for
//   EXPORT_DAYS. The package is built from live data on each download.
// - RECTIFICATION: approval means "we will correct it"; HR corrects the
//   records through the usual screens, then completes it with a note.
// - ERASURE: only a System Admin approves, never the person who logged it
//   (four eyes, also a database CHECK). Approval crypto-shreds: leftover
//   plaintext identifiers are sealed, the employee's data key is destroyed,
//   their search-index rows go, and their identity scans (credential types
//   with a sensitive field) are deleted from the vault. Ordinary employment
//   data (name, job number, contracts, rosters) stays under its own lawful
//   basis (processing register). The request keeps the evidence: when the
//   key was destroyed, and when the last backup holding the old ciphertext
//   expires (BACKUP_RETENTION_DAYS after the next nightly backup).
// Nobody decides on their own request. A request is never deleted, and is
// final once rejected or completed (database trigger).

import { Router, type Response } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { dbDate } from '../../lib/dates.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import { logger } from '../../lib/logger.js';
import { Prisma, type Db, type DbClient } from '../../lib/prisma.js';
import type { Vault } from '../../lib/vault.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { HR_ROLES, inScope } from '../credentials/access.js';
import { presentTemplate, WITH_FIELDS } from '../credentials/fields.js';
import { unitScope, type AuthContext } from '../users/access.js';
import type { Protection, TrackingValues } from './protection.js';

export const REQUEST_TYPES = ['ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE'] as const;
export const REQUEST_STATUSES = ['RECEIVED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED'] as const;
/** PDPL implementing regulation: answer a data-subject request within 30 days. */
export const RESPONSE_DAYS = 30;
/** How long an approved access / portability package stays downloadable. */
export const EXPORT_DAYS = 30;
const OPEN = ['RECEIVED', 'IN_REVIEW', 'APPROVED'] as const;
const DAY = 86_400_000;

const Note = z.string().trim().min(10, 'Give a note of at least 10 characters').max(2000);
const Details = z.string().trim().max(2000).optional();
export const OwnRequestBody = z.strictObject({ type: z.enum(REQUEST_TYPES), details: Details })
  .refine((b) => b.type !== 'RECTIFICATION' || (b.details?.length ?? 0) >= 10, { message: 'Say what is wrong and what it should be (at least 10 characters)', path: ['details'] });
export const LogRequestBody = z.strictObject({ employeeId: z.number().int().positive(), type: z.enum(REQUEST_TYPES), details: Details })
  .refine((b) => b.type !== 'RECTIFICATION' || (b.details?.length ?? 0) >= 10, { message: 'Say what is wrong and what it should be (at least 10 characters)', path: ['details'] });
export const ListQuery = z.object({ status: z.enum(REQUEST_STATUSES).optional(), type: z.enum(REQUEST_TYPES).optional(), open: z.enum(['true', 'false']).optional() });
export const ApproveBody = z.strictObject({ note: z.string().trim().max(2000).optional() });
export const NoteBody = z.strictObject({ note: Note });
export const EraseBody = z.strictObject({ note: Note, confirmJobNumber: z.string().trim().min(1).max(50) });
const IdParam = z.object({ id: z.coerce.number().int().positive() });

type Row = Prisma.DataSubjectRequestGetPayload<{ include: typeof INCLUDE }>;
const person = { select: { id: true, displayName: true } } as const;
const INCLUDE = {
  employee: { select: { id: true, fullName: true, jobNumber: true, unitId: true } },
  requestedBy: person, reviewedBy: person, decidedBy: person,
} as const;

function present(r: Row, now = new Date()) {
  const dueAt = new Date(r.requestedAt.getTime() + RESPONSE_DAYS * DAY);
  const exportable = (r.requestType === 'ACCESS' || r.requestType === 'PORTABILITY') && r.status === 'COMPLETED' && r.completedAt !== null;
  const exportExpiresAt = exportable ? new Date(r.completedAt!.getTime() + EXPORT_DAYS * DAY) : null;
  return {
    id: r.id, type: r.requestType, status: r.status, details: r.details,
    employee: r.employee,
    requestedBy: r.requestedBy, requestedAt: r.requestedAt,
    reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt,
    decidedBy: r.decidedBy, decidedAt: r.decidedAt, decisionNote: r.decisionNote, completedAt: r.completedAt,
    dueAt, overdue: (OPEN as readonly string[]).includes(r.status) && now > dueAt,
    exportAvailable: exportExpiresAt !== null && now < exportExpiresAt, exportExpiresAt,
    erasure: r.keyDestroyedAt ? { keyDestroyedAt: r.keyDestroyedAt, backupsExpireAt: r.backupsExpireAt, documentsErased: r.documentsErased } : null,
  };
}

export interface DataSubjectDeps { db: Db; protection: Protection; vault: Vault; backupRetentionDays: number }

export function createDataSubjectService({ db, protection, vault, backupRetentionDays }: DataSubjectDeps) {
  async function load(tx: DbClient, id: number) {
    const r = await tx.dataSubjectRequest.findUnique({ where: { id }, include: INCLUDE });
    if (!r) throw notFound('Request not found');
    return r;
  }

  /** HR (or System Admin) scope over the employee; a deleted employee's requests stay workable. */
  async function assertScope(tx: DbClient, auth: AuthContext, employee: { unitId: number | null }) {
    if (!inScope(await unitScope(tx, auth, HR_ROLES), employee.unitId)) throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This employee is outside your assigned scope');
  }
  const notOwn = (auth: AuthContext, r: { employeeId: number }) => {
    if (auth.user.employeeId === r.employeeId) throw new HttpError(403, 'SELF_REVIEW_FORBIDDEN', 'You cannot decide on a request about your own data');
  };
  const expect = (r: { status: string }, from: readonly string[], action: string) => {
    if (!from.includes(r.status)) throw new HttpError(409, 'INVALID_TRANSITION', `A ${r.status.toLowerCase().replace('_', ' ')} request cannot be ${action}`);
  };

  /** Scoped HR and System Admins get a notice; for an erasure only System Admins, who approve it. */
  async function notifyReviewers(tx: DbClient, r: { id: number; requestType: string; employee: { fullName: string; unitId: number | null } }) {
    const unit = r.employee.unitId === null ? null : await tx.unit.findUnique({ where: { id: r.employee.unitId }, select: { departmentId: true } });
    const roles = r.requestType === 'ERASURE' ? (['SYSTEM_ADMIN'] as const) : HR_ROLES;
    const now = new Date();
    const grants = await tx.roleAssignment.findMany({
      where: { role: { in: [...roles] }, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], user: { isActive: true } },
      select: { userId: true, scopeType: true, scopeIds: true },
    });
    const covers = (g: { scopeType: string; scopeIds: number[] }) => g.scopeType === 'SYSTEM'
      || (g.scopeType === 'UNIT' && r.employee.unitId !== null && g.scopeIds.includes(r.employee.unitId))
      || (g.scopeType === 'DEPARTMENT' && unit !== null && g.scopeIds.includes(unit.departmentId));
    const recipients = [...new Set(grants.filter(covers).map((g) => g.userId))];
    const kind = { ACCESS: ['a copy of their personal data', 'نسخة من بياناته الشخصية'], PORTABILITY: ['an export of their personal data', 'تصدير بياناته الشخصية'], RECTIFICATION: ['a correction of their personal data', 'تصحيح بياناته الشخصية'], ERASURE: ['erasure of their sensitive personal data', 'محو بياناته الشخصية الحساسة'] }[r.requestType as typeof REQUEST_TYPES[number]];
    await tx.notification.createMany({
      data: recipients.map((userId) => ({
        recipientId: userId, type: 'SYSTEM' as const, priority: r.requestType === 'ERASURE' ? ('HIGH' as const) : ('MEDIUM' as const),
        title: 'Personal data request', message: `${r.employee.fullName} asked for ${kind[0]}. Answer within ${RESPONSE_DAYS} days (Administration → Data protection).`,
        titleAr: 'طلب بيانات شخصية', messageAr: `طلب ${r.employee.fullName} ${kind[1]}. يجب الرد خلال ${RESPONSE_DAYS} يومًا (الإدارة ← حماية البيانات).`,
        eventKey: `dsr:${r.id}:received`,
      })),
      skipDuplicates: true,
    });
  }

  /** The employee hears when their request is decided. */
  async function notifySubject(tx: DbClient, r: { id: number; employeeId: number; requestType: string }, outcome: 'APPROVED' | 'REJECTED' | 'COMPLETED') {
    const user = await tx.user.findFirst({ where: { employeeId: r.employeeId, isActive: true }, select: { id: true } });
    if (!user) return;
    const [en, ar] = {
      APPROVED: ['was approved; HR will make the correction', 'تمت الموافقة عليه؛ ستقوم الموارد البشرية بالتصحيح'],
      REJECTED: ['was declined — the reason is on the My data page', 'تم رفضه — السبب في صفحة بياناتي'],
      COMPLETED: r.requestType === 'ACCESS' || r.requestType === 'PORTABILITY'
        ? [`is ready: download your data from the My data page within ${EXPORT_DAYS} days`, `جاهز: نزّل بياناتك من صفحة بياناتي خلال ${EXPORT_DAYS} يومًا`]
        : ['was completed', 'تم إنجازه'],
    }[outcome];
    await tx.notification.createMany({
      data: [{ recipientId: user.id, type: 'SYSTEM', priority: 'MEDIUM', title: 'Your personal data request', message: `Your request ${en}.`, titleAr: 'طلب بياناتك الشخصية', messageAr: `طلبك ${ar}.`, eventKey: `dsr:${r.id}:${outcome}` }],
      skipDuplicates: true,
    });
  }

  async function open(tx: DbClient, actor: AuthContext, employee: { id: number; fullName: string; unitId: number | null }, type: string, details: string | undefined, requestId?: string) {
    const existing = await tx.dataSubjectRequest.findFirst({ where: { employeeId: employee.id, requestType: type, status: { in: [...OPEN] } }, select: { id: true } });
    if (existing) throw new HttpError(409, 'REQUEST_ALREADY_OPEN', 'A request of this type is already open for this employee', { requestId: existing.id });
    let created;
    try {
      created = await tx.dataSubjectRequest.create({ data: { employeeId: employee.id, requestType: type, details: details || null, requestedById: actor.user.id }, include: INCLUDE });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new HttpError(409, 'REQUEST_ALREADY_OPEN', 'A request of this type is already open for this employee');
      throw e;
    }
    // Details may describe personal data (a correction): only whether there were any is audited.
    await appendAudit(tx, { actorUserId: actor.user.id, action: 'DATA_SUBJECT_REQUEST_RECEIVED', resource: 'data_subject_request', resourceId: created.id, changes: { employeeId: employee.id, type, onBehalf: actor.user.employeeId !== employee.id, details: Boolean(details) }, requestId, priority: type === 'ERASURE' ? 'HIGH' : undefined });
    await notifyReviewers(tx, { id: created.id, requestType: type, employee });
    return present(created);
  }

  /** Decision bookkeeping shared by approve / reject / complete / erase. */
  async function decide(tx: DbClient, auth: AuthContext, r: Row, data: Prisma.DataSubjectRequestUpdateInput, action: string, changes: Record<string, unknown>, requestId?: string, priority?: 'HIGH') {
    const now = new Date();
    const updated = await tx.dataSubjectRequest.update({ where: { id: r.id }, data: { decidedBy: { connect: { id: auth.user.id } }, decidedAt: r.decidedAt ?? now, ...data }, include: INCLUDE });
    await appendAudit(tx, { actorUserId: auth.user.id, action, resource: 'data_subject_request', resourceId: r.id, changes: { employeeId: r.employeeId, type: r.requestType, ...changes }, requestId, priority });
    return updated;
  }

  /** Everything the application holds about one employee, sensitive values opened (spec §8.3.3 access / portability). */
  async function buildPackage(tx: DbClient, r: Row) {
    const employeeId = r.employeeId;
    const e = await tx.employee.findUniqueOrThrow({ where: { id: employeeId }, include: { unit: { select: { code: true, name: true } }, position: { select: { code: true, title: true } } } });
    const user = await tx.user.findUnique({
      where: { employeeId },
      select: {
        id: true, email: true, displayName: true, isActive: true, createdAt: true, lastLoginAt: true,
        roleAssignments: { where: { revokedAt: null }, select: { role: true, scopeType: true, grantedAt: true, expiresAt: true } },
        mfaFactor: { select: { confirmedAt: true } },
      },
    });
    const docMeta = { select: { version: true, fileName: true, mimeType: true, sizeBytes: true, uploadedAt: true, erasedAt: true }, orderBy: { version: 'asc' as const } };
    const [contracts, credentials, waivers, eligibility, shifts, attendance, notifications, requests, register] = await Promise.all([
      tx.contract.findMany({ where: { employeeId }, include: { documents: docMeta }, orderBy: { startDate: 'asc' } }),
      tx.credential.findMany({ where: { employeeId }, include: { template: { select: { code: true, name: true } }, documents: docMeta }, orderBy: { id: 'asc' } }),
      tx.credentialWaiver.findMany({ where: { employeeId }, include: { template: { select: { code: true, name: true } } }, orderBy: { createdAt: 'asc' } }),
      tx.eligibilityState.findUnique({ where: { employeeId } }),
      tx.shiftAssignment.findMany({ where: { employeeId, status: { not: 'Draft' } }, include: { unit: { select: { code: true, name: true } } }, orderBy: { shiftDate: 'asc' } }),
      tx.attendanceEvent.findMany({ where: { employeeId }, orderBy: { eventTimestamp: 'asc' } }),
      user ? tx.notification.findMany({ where: { recipientId: user.id }, orderBy: { createdAt: 'asc' } }) : Promise.resolve([]),
      tx.dataSubjectRequest.findMany({ where: { employeeId }, orderBy: { requestedAt: 'asc' } }),
      tx.processingRegister.findMany({ where: { isActive: true }, orderBy: [{ dataCategory: 'asc' }] }),
    ]);
    const cache = new Map<number, Buffer | null>();
    const opened = [];
    for (const c of credentials) {
      const tracking = await protection.reveal(tx, employeeId, c.trackingData, cache);
      const pendingTracking = c.pendingData && typeof c.pendingData === 'object' && 'trackingData' in c.pendingData
        ? await protection.reveal(tx, employeeId, (c.pendingData as { trackingData: unknown }).trackingData, cache) : null;
      opened.push({
        type: c.template, status: c.status, statusReason: c.statusReason,
        issueDate: c.issueDate ? dbDate(c.issueDate) : null, expiryDate: c.expiryDate ? dbDate(c.expiryDate) : null, expiryDateHijri: c.expiryDateHijri,
        details: tracking.data, pendingRenewal: pendingTracking ? pendingTracking.data : null,
        personalDataErased: tracking.erased || Boolean(pendingTracking?.erased), verifiedAt: c.verifiedAt,
        documents: c.documents.map(({ erasedAt, ...d }) => ({ ...d, erased: erasedAt !== null })),
      });
    }
    return {
      format: 'aigh-nurseapp/personal-data', version: 1, generatedAt: new Date(), request: { id: r.id, type: r.requestType },
      note: 'Your personal data held by the AIGH Nursing Workforce system. Stored document files are listed, not attached: open them from the application or ask HR for copies.',
      employee: {
        jobNumber: e.jobNumber, firstName: e.firstName, middleName: e.middleName, lastName: e.lastName, fullName: e.fullName,
        jobTitle: e.jobTitle, fileNo: e.fileNo, rankGrade: e.rankGrade, nationality: e.nationality, jobPostLocation: e.jobPostLocation,
        actualWorkPlace: e.actualWorkPlace, specialty: e.specialty, maritalStatus: e.maritalStatus, salary: e.salary === null ? null : e.salary.toFixed(2),
        contactEmail: e.contactEmail, primaryPhone: e.primaryPhone, emergencyContactPhone: e.emergencyContactPhone,
        unit: e.unit, position: e.position, status: e.status, hireDate: e.hireDate ? dbDate(e.hireDate) : null, createdAt: e.createdAt, updatedAt: e.updatedAt,
      },
      account: user ? {
        email: user.email, displayName: user.displayName, isActive: user.isActive, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt,
        roles: user.roleAssignments, authenticatorApp: Boolean(user.mfaFactor?.confirmedAt),
      } : null,
      contracts: contracts.map((c) => ({
        startDate: dbDate(c.startDate), endDate: dbDate(c.endDate), startDateHijri: c.startDateHijri, endDateHijri: c.endDateHijri, status: c.status, approvedAt: c.approvedAt,
        documents: c.documents.map(({ erasedAt, ...d }) => ({ ...d, erased: erasedAt !== null })),
      })),
      credentials: opened,
      waivers: waivers.map((w) => ({ type: w.template, reason: w.reason, createdAt: w.createdAt, expiresAt: w.expiresAt })),
      eligibility: eligibility ? { status: eligibility.status, reasons: eligibility.reasons, calculatedAt: eligibility.calculatedAt } : null,
      shifts: shifts.map((s) => ({ date: dbDate(s.shiftDate), shiftType: s.shiftType, unit: s.unit, status: s.status })),
      attendance: attendance.map((a) => ({ eventType: a.eventType, at: a.eventTimestamp, source: a.source, deviceId: a.deviceId, locationCode: a.locationCode })),
      notifications: notifications.map((n) => ({ type: n.type, title: n.title, message: n.message, createdAt: n.createdAt, readAt: n.readAt })),
      dataSubjectRequests: requests.map((q) => ({ type: q.requestType, status: q.status, requestedAt: q.requestedAt, decidedAt: q.decidedAt, completedAt: q.completedAt, decisionNote: q.decisionNote, keyDestroyedAt: q.keyDestroyedAt, backupsExpireAt: q.backupsExpireAt })),
      processingPurposes: register.map((p) => ({ dataCategory: p.dataCategory, lawfulBasis: p.lawfulBasis, purpose: p.purpose, retention: p.retentionRule })),
    };
  }

  async function exportOf(auth: AuthContext, r: Row, requestId?: string) {
    const view = present(r);
    if (!view.exportAvailable) {
      throw new HttpError(409, 'EXPORT_NOT_AVAILABLE', view.exportExpiresAt ? 'This package has expired; make a new request' : 'The package is available once an access or portability request is approved');
    }
    const pkg = await buildPackage(db, r);
    await appendAudit(db, { actorUserId: auth.user.id, action: 'PERSONAL_DATA_EXPORTED', resource: 'data_subject_request', resourceId: r.id, changes: { employeeId: r.employeeId, type: r.requestType, bySubject: auth.user.employeeId === r.employeeId }, requestId, priority: 'HIGH' });
    return { fileName: `personal-data-${r.employee.jobNumber}-${new Date().toISOString().slice(0, 10)}.json`, body: JSON.stringify(pkg, null, 2) };
  }

  return {
    // ── The employee ────────────────────────────────────────────────────────
    async listOwn(auth: AuthContext) {
      if (auth.user.employeeId === null) return { items: [], total: 0 };
      const rows = await db.dataSubjectRequest.findMany({ where: { employeeId: auth.user.employeeId }, include: INCLUDE, orderBy: { requestedAt: 'desc' } });
      const items = rows.map((r) => present(r));
      return { items, total: items.length };
    },

    async createOwn(auth: AuthContext, body: z.infer<typeof OwnRequestBody>, requestId?: string) {
      if (auth.user.employeeId === null) throw new HttpError(404, 'NO_EMPLOYEE_RECORD', 'Your account is not linked to an employee record');
      const employeeId = auth.user.employeeId;
      return db.$transaction(async (tx) => {
        const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: { id: true, fullName: true, unitId: true } });
        if (!employee) throw notFound('Employee not found');
        return open(tx, auth, employee, body.type, body.details, requestId);
      });
    },

    async exportOwn(auth: AuthContext, id: number, requestId?: string) {
      const r = await load(db, id);
      if (auth.user.employeeId !== r.employeeId) throw notFound('Request not found');
      return exportOf(auth, r, requestId);
    },

    // ── HR / System Admin ─────────────────────────────────────────────────
    async list(auth: AuthContext, q: z.infer<typeof ListQuery>) {
      const scope = await unitScope(db, auth, HR_ROLES);
      const rows = await db.dataSubjectRequest.findMany({
        where: {
          ...(q.status ? { status: q.status } : q.open === 'true' ? { status: { in: [...OPEN] } } : {}),
          ...(q.type ? { requestType: q.type } : {}),
          ...(scope.all ? {} : { employee: { unitId: { in: [...scope.unitIds] } } }),
        },
        include: INCLUDE,
        orderBy: { requestedAt: 'desc' },
        take: 500,
      });
      const items = rows.map((r) => present(r));
      return { items, total: items.length };
    },

    /** A request received outside the application (paper, e-mail), logged for the employee. */
    async create(auth: AuthContext, body: z.infer<typeof LogRequestBody>, requestId?: string) {
      return db.$transaction(async (tx) => {
        const employee = await tx.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, fullName: true, unitId: true } });
        if (!employee) throw notFound('Employee not found');
        await assertScope(tx, auth, employee);
        return open(tx, auth, employee, body.type, body.details, requestId);
      });
    },

    async review(auth: AuthContext, id: number, requestId?: string) {
      return db.$transaction(async (tx) => {
        const r = await load(tx, id);
        await assertScope(tx, auth, r.employee);
        notOwn(auth, r);
        expect(r, ['RECEIVED'], 'taken into review');
        const updated = await tx.dataSubjectRequest.update({ where: { id }, data: { status: 'IN_REVIEW', reviewedById: auth.user.id, reviewedAt: new Date() }, include: INCLUDE });
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'DATA_SUBJECT_REQUEST_IN_REVIEW', resource: 'data_subject_request', resourceId: id, changes: { employeeId: r.employeeId, type: r.requestType }, requestId });
        return present(updated);
      });
    },

    /** Access / portability: completes (package ready). Rectification: approved, to be corrected. Not for erasure. */
    async approve(auth: AuthContext, id: number, note: string | undefined, requestId?: string) {
      return db.$transaction(async (tx) => {
        const r = await load(tx, id);
        await assertScope(tx, auth, r.employee);
        notOwn(auth, r);
        if (r.requestType === 'ERASURE') throw new HttpError(409, 'ERASURE_NEEDS_SYSTEM_ADMIN', 'An erasure is approved by a System Admin with Erase data');
        expect(r, ['RECEIVED', 'IN_REVIEW'], 'approved');
        const completes = r.requestType !== 'RECTIFICATION';
        const updated = await decide(tx, auth, r, { status: completes ? 'COMPLETED' : 'APPROVED', decisionNote: note || null, ...(completes ? { completedAt: new Date() } : {}) }, completes ? 'DATA_SUBJECT_REQUEST_COMPLETED' : 'DATA_SUBJECT_REQUEST_APPROVED', { note: Boolean(note) }, requestId);
        await notifySubject(tx, r, completes ? 'COMPLETED' : 'APPROVED');
        return present(updated);
      });
    },

    async reject(auth: AuthContext, id: number, note: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        const r = await load(tx, id);
        await assertScope(tx, auth, r.employee);
        notOwn(auth, r);
        expect(r, ['RECEIVED', 'IN_REVIEW'], 'declined');
        const updated = await decide(tx, auth, r, { status: 'REJECTED', decisionNote: note }, 'DATA_SUBJECT_REQUEST_REJECTED', { reason: note }, requestId, r.requestType === 'ERASURE' ? 'HIGH' : undefined);
        await notifySubject(tx, r, 'REJECTED');
        return present(updated);
      });
    },

    /** Rectification: the correction was made (note says what changed). */
    async complete(auth: AuthContext, id: number, note: string, requestId?: string) {
      return db.$transaction(async (tx) => {
        const r = await load(tx, id);
        await assertScope(tx, auth, r.employee);
        notOwn(auth, r);
        if (r.requestType !== 'RECTIFICATION') throw new HttpError(409, 'INVALID_TRANSITION', 'Only a correction request is completed this way');
        expect(r, ['APPROVED'], 'completed');
        const updated = await decide(tx, auth, r, { status: 'COMPLETED', completedAt: new Date(), decisionNote: note }, 'DATA_SUBJECT_REQUEST_COMPLETED', { note: true }, requestId);
        await notifySubject(tx, r, 'COMPLETED');
        return present(updated);
      });
    },

    /** Erasure by crypto-shredding — System Admin, four eyes, the job number typed as confirmation. */
    async erase(auth: AuthContext, id: number, body: z.infer<typeof EraseBody>, requestId?: string) {
      const now = new Date();
      const { result, storageKeys } = await db.$transaction(async (tx) => {
        const r = await load(tx, id);
        await assertScope(tx, auth, r.employee);
        notOwn(auth, r);
        if (r.requestType !== 'ERASURE') throw new HttpError(409, 'INVALID_TRANSITION', 'Only an erasure request is approved this way');
        expect(r, ['RECEIVED', 'IN_REVIEW'], 'approved');
        if (r.requestedById === auth.user.id) throw new HttpError(403, 'FOUR_EYES_REQUIRED', 'You logged this erasure request; another System Admin must approve it');
        if (body.confirmJobNumber !== r.employee.jobNumber) throw new HttpError(422, 'CONFIRMATION_MISMATCH', 'Type the employee\'s job number exactly to confirm the erasure');

        const shred = await shredEmployee(tx, protection, r.employeeId, auth.user.id, now);
        const documentsErased = shred.storageKeys.length;
        // The evidence: backups taken before now age out BACKUP_RETENTION_DAYS after the next nightly backup.
        const backupsExpireAt = new Date(now.getTime() + (backupRetentionDays + 1) * DAY);
        const updated = await decide(tx, auth, r, { status: 'COMPLETED', decisionNote: body.note, completedAt: now, keyDestroyedAt: now, backupsExpireAt, documentsErased },
          'PERSONAL_DATA_ERASED', { note: body.note, keyDestroyedAt: now, backupsExpireAt, documentsErased, credentials: shred.credentials }, requestId, 'HIGH');
        await notifySubject(tx, r, 'COMPLETED');
        return { result: present(updated), storageKeys: shred.storageKeys };
      });
      // A copy outside the database: after restoring an older backup, these lines say which
      // erasures to apply again (npm run pdpl:reerase; docs/DEPLOYMENT.md §5).
      logger.warn('personal data erased', { requestId, employeeId: result.employee.id, dsrId: result.id, keyDestroyedAt: now.toISOString() });
      // After commit: the rows already say "erased", so a file left behind here is never served,
      // and the daily vault check removes it.
      for (const key of storageKeys) {
        try { await vault.adapter.remove(key); } catch (e) { logger.error('erased document could not be removed from storage', { requestId, error: (e as Error).message }); }
      }
      return result;
    },

    async exportFor(auth: AuthContext, id: number, requestId?: string) {
      const r = await load(db, id);
      await assertScope(db, auth, r.employee);
      return exportOf(auth, r, requestId);
    },
  };
}

export type DataSubjectService = ReturnType<typeof createDataSubjectService>;

/**
 * The erasure itself (spec §8.3.3): seals any value still in plaintext (stored before D-54),
 * destroys the employee's key, drops their search-index rows, and marks their identity scans
 * (files of credential types with a sensitive field) erased. Returns the storage keys to remove
 * from the vault once the transaction commits.
 */
export async function shredEmployee(tx: DbClient, protection: Protection, employeeId: number, actorUserId: number | null, now: Date) {
  const creds = await tx.credential.findMany({ where: { employeeId }, include: { template: { include: WITH_FIELDS } } });
  const identity = creds.map((c) => ({ c, fields: presentTemplate(c.template).fieldDefs })).filter(({ fields }) => fields.some((f) => f.pdplCategory));
  for (const { c, fields } of identity) {
    const pending = c.pendingData as { trackingData?: TrackingValues } | null;
    const trackingData = await protection.seal(tx, employeeId, fields, (c.trackingData ?? {}) as TrackingValues, { checkRegister: false });
    const pendingData = pending?.trackingData ? { ...pending, trackingData: await protection.seal(tx, employeeId, fields, pending.trackingData, { checkRegister: false }) } : pending;
    await tx.credential.update({ where: { id: c.id }, data: { trackingData, pendingData: pendingData ?? Prisma.DbNull } });
  }
  await protection.destroyKey(tx, employeeId, now);
  const docs = await tx.documentVersion.findMany({ where: { credentialId: { in: identity.map(({ c }) => c.id) }, erasedAt: null }, select: { id: true, storageKey: true } });
  const ids = docs.map((d) => d.id);
  await tx.documentVersion.updateMany({ where: { id: { in: ids }, reviewStatus: 'PENDING_REVIEW' }, data: { reviewStatus: 'REJECTED', reviewedById: actorUserId, reviewedAt: now } });
  await tx.documentVersion.updateMany({ where: { id: { in: ids } }, data: { erasedAt: now } });
  await tx.downloadLink.updateMany({ where: { documentId: { in: ids }, usedAt: null }, data: { usedAt: now } });
  return { storageKeys: docs.map((d) => d.storageKey), credentials: identity.length };
}

function sendPackage(res: Response, file: { fileName: string; body: string }) {
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`, 'X-Content-Type-Options': 'nosniff' }).send(file.body);
}

export function createDataSubjectRouter(dsr: DataSubjectService) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  // Own requests: no permission — the caller's employee record is the subject.
  r.get('/pdpl/requests/me', async (_req, res) => { res.json(await dsr.listOwn(authOf(res))); });
  r.post('/pdpl/requests/me', async (req, res) => { res.status(201).json(await dsr.createOwn(authOf(res), OwnRequestBody.parse(req.body), rid(res))); });
  r.get('/pdpl/requests/me/:id/export', async (req, res) => { sendPackage(res, await dsr.exportOwn(authOf(res), IdParam.parse(req.params).id, rid(res))); });

  r.get('/pdpl/requests', authorize('pdpl.requests'), async (req, res) => { res.json(await dsr.list(authOf(res), ListQuery.parse(req.query))); });
  r.post('/pdpl/requests', authorize('pdpl.requests'), async (req, res) => { res.status(201).json(await dsr.create(authOf(res), LogRequestBody.parse(req.body), rid(res))); });
  r.post('/pdpl/requests/:id/review', authorize('pdpl.requests'), async (req, res) => { res.json(await dsr.review(authOf(res), IdParam.parse(req.params).id, rid(res))); });
  r.post('/pdpl/requests/:id/approve', authorize('pdpl.requests'), async (req, res) => {
    res.json(await dsr.approve(authOf(res), IdParam.parse(req.params).id, ApproveBody.parse(req.body).note, rid(res)));
  });
  r.post('/pdpl/requests/:id/reject', authorize('pdpl.requests'), async (req, res) => {
    res.json(await dsr.reject(authOf(res), IdParam.parse(req.params).id, NoteBody.parse(req.body).note, rid(res)));
  });
  r.post('/pdpl/requests/:id/complete', authorize('pdpl.requests'), async (req, res) => {
    res.json(await dsr.complete(authOf(res), IdParam.parse(req.params).id, NoteBody.parse(req.body).note, rid(res)));
  });
  r.post('/pdpl/requests/:id/erase', authorize('pdpl.erase'), async (req, res) => {
    res.json(await dsr.erase(authOf(res), IdParam.parse(req.params).id, EraseBody.parse(req.body), rid(res)));
  });
  r.get('/pdpl/requests/:id/export', authorize('pdpl.requests'), async (req, res) => { sendPackage(res, await dsr.exportFor(authOf(res), IdParam.parse(req.params).id, rid(res))); });

  return r;
}
