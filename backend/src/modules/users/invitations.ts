// Registration by invitation (spec §3.2). HR invites an unclaimed employee with
// current approved employment coverage; the employee claims one self-service
// account with the private link, their Job Number and the invited e-mail.
//
// - The token (32 random bytes) exists only in the e-mail: the database keeps
//   its SHA-256, and no API response ever contains it. The link carries it after
//   "#", which browsers never send to a server, so it stays out of access logs.
// - 72 hours, single use; a new invitation revokes the employee's open ones.
// - Preview needs the token AND the Job Number; the Job Number alone discloses
//   nothing. Every failure is the same generic error.
// - The claim re-checks eligibility with the invitation and employee rows
//   locked, so concurrent attempts produce exactly one account.
// - Preview and claim share a per-client throttle kept in PostgreSQL (D-46).

import crypto from 'node:crypto';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { riyadhDate } from '../../lib/dates.js';
import { renderEmail } from '../../lib/email-templates.js';
import { conflict, HttpError, notFound } from '../../lib/http-errors.js';
import { PasswordSchema, type PasswordService } from '../../lib/passwords.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import type { Throttle } from '../../lib/throttle.js';
import { unitScope, type AuthContext } from './access.js';

export const INVITATION_HOURS = 72;
const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;
const COVERING = ['Approved', 'Active'] as const;

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid token');
const JobNumber = z.string().trim().min(1).max(40);
export const PreviewBody = z.strictObject({ token: Token, jobNumber: JobNumber });
export const ClaimBody = z.strictObject({
  token: Token, jobNumber: JobNumber,
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: PasswordSchema,
});

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
/** The one error a claimant sees for any bad token / Job Number / e-mail combination. */
const invalid = () => new HttpError(400, 'INVITATION_INVALID', 'This invitation link is not valid, has expired or does not match the Job Number and e-mail entered');
const tooMany = (wait: number) => new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts — try again later', { retryAfterSeconds: wait });

/** "n•••@aigh.sa": enough for the employee to recognise the address, not enough to learn it. */
export function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local!.slice(0, 1)}•••@${domain}`;
}

export interface InvitationDeps {
  db: Db;
  passwords: PasswordService;
  /** Per-client throttle for preview and claim. */
  throttle: Throttle;
  /** The app's public URL (the claim page lives at <baseUrl>/claim). */
  baseUrl: string;
  /** Invitations are only useful by e-mail; refused when e-mail is off. */
  mailEnabled: boolean;
}

export function createInvitationService({ db, passwords, throttle, baseUrl, mailEnabled }: InvitationDeps) {
  /** Spec §3.2 eligibility: an employee without an account, covered by an Approved/Active contract today. */
  async function eligibility(tx: DbClient, employeeId: number) {
    const today = new Date(`${riyadhDate()}T00:00:00Z`);
    const emp = await tx.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: {
        id: true, jobNumber: true, fullName: true, contactEmail: true, unitId: true,
        user: { select: { id: true } },
        contracts: { where: { status: { in: [...COVERING] }, startDate: { lte: today }, endDate: { gte: today } }, select: { id: true }, take: 1 },
      },
    });
    if (!emp) return { emp: null, reason: 'EMPLOYEE_NOT_FOUND' as const };
    if (emp.user) return { emp, reason: 'EMPLOYEE_HAS_ACCOUNT' as const };
    if (emp.contracts.length === 0) return { emp, reason: 'NO_CURRENT_CONTRACT' as const };
    return { emp, reason: null };
  }

  async function assertInScope(auth: AuthContext, unitId: number | null) {
    const scope = await unitScope(db, auth, ADMIN_ROLES);
    if (!scope.all && (unitId === null || !scope.unitIds.has(unitId))) {
      throw new HttpError(403, 'SCOPE_NOT_COVERED', 'This employee is outside your assigned scope');
    }
  }

  async function checkThrottle(clientIp: string) {
    const wait = await throttle.blockedFor(`claim-ip:${clientIp}`);
    if (wait > 0) throw tooMany(wait);
  }

  /** The open invitation for a token, with its employee, or null. */
  async function openInvitation(tx: DbClient, token: string, lock: boolean) {
    const h = hashToken(token);
    if (lock) await tx.$queryRaw`SELECT id FROM invitations WHERE token_hash = ${h} FOR UPDATE`;
    const inv = await tx.invitation.findUnique({
      where: { tokenHash: h },
      include: { employee: { select: { id: true, jobNumber: true, fullName: true, unit: { select: { name: true, nameAr: true } }, position: { select: { title: true, titleAr: true } } } } },
    });
    if (!inv || inv.usedAt || inv.revokedAt || inv.expiresAt.getTime() <= Date.now()) return null;
    return inv;
  }

  const sameJobNumber = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  return {
    /** HR: issue (or re-issue) an invitation; the link is e-mailed, never returned. */
    async issue(auth: AuthContext, employeeId: number, requestId?: string) {
      if (!mailEnabled) throw conflict('EMAIL_OFF', 'Invitations are sent by e-mail, and e-mail is not configured (SMTP_HOST)');
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + INVITATION_HOURS * 3600_000);
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE`;
        const { emp, reason } = await eligibility(tx, employeeId);
        if (!emp) throw notFound('Employee not found');
        await assertInScope(auth, emp.unitId);
        if (reason === 'EMPLOYEE_HAS_ACCOUNT') throw conflict(reason, 'This employee already has a login account');
        if (reason === 'NO_CURRENT_CONTRACT') throw conflict(reason, 'Only an employee with a current approved or active contract can be invited (spec §3.2)');
        const email = emp.contactEmail.trim().toLowerCase();
        if (!z.email().safeParse(email).success) throw conflict('CONTACT_EMAIL_INVALID', 'Set a valid contact e-mail on the employee record first');
        if (await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } })) {
          throw conflict('EMAIL_IN_USE', 'Another login account already uses this e-mail address');
        }
        const revoked = await tx.invitation.updateMany({ where: { employeeId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
        const inv = await tx.invitation.create({ data: { employeeId, email, tokenHash: hashToken(token), expiresAt, createdById: auth.user.id }, select: { id: true } });
        const link = `${baseUrl.replace(/\/$/, '')}/claim#token=${token}`;
        const mail = renderEmail({
          title: 'Your AIGH Nursing Workforce account',
          message: `You have been invited to create your account. Open the link below within ${INVITATION_HOURS} hours, enter your Job Number, and choose a password. The link works once.\n\n${link}\n\nIf you did not expect this e-mail, ignore it.`,
          titleAr: 'حسابك في نظام القوى العاملة التمريضية',
          messageAr: `تمت دعوتك لإنشاء حسابك. افتح الرابط التالي خلال ${INVITATION_HOURS} ساعة، وأدخل رقمك الوظيفي، واختر كلمة مرور. يعمل الرابط مرة واحدة.\n\n${link}`,
        });
        await tx.emailOutbox.create({
          data: { toAddress: email, subject: mail.subject, bodyText: mail.text, bodyHtml: mail.html, priority: 'HIGH', eventKey: `invitation:${inv.id}` },
        });
        await appendAudit(tx, {
          actorUserId: auth.user.id, action: 'INVITATION_ISSUED', resource: 'employee', resourceId: employeeId,
          changes: { invitationId: inv.id, email, expiresAt: expiresAt.toISOString(), revokedEarlier: revoked.count }, requestId,
        });
        return { id: inv.id, email, expiresAt };
      });
    },

    /** HR: invitation history for one employee (never the token). */
    async list(auth: AuthContext, employeeId: number) {
      const emp = await db.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { unitId: true } });
      if (!emp) throw notFound('Employee not found');
      await assertInScope(auth, emp.unitId);
      const rows = await db.invitation.findMany({
        where: { employeeId }, orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, email: true, createdAt: true, expiresAt: true, usedAt: true, revokedAt: true, createdById: true },
      });
      const now = Date.now();
      const items = rows.map((r) => ({
        ...r,
        status: r.usedAt ? 'CLAIMED' : r.revokedAt ? 'REVOKED' : r.expiresAt.getTime() <= now ? 'EXPIRED' : 'OPEN',
      }));
      return { items, total: items.length };
    },

    /** Public: the employee's own details, shown only for a valid token + matching Job Number. */
    async preview(body: z.infer<typeof PreviewBody>, clientIp: string) {
      await checkThrottle(clientIp);
      const inv = await openInvitation(db, body.token, false);
      if (!inv || !sameJobNumber(inv.employee.jobNumber, body.jobNumber)) {
        await throttle.fail(`claim-ip:${clientIp}`);
        throw invalid();
      }
      const e = inv.employee;
      return {
        fullName: e.fullName, jobNumber: e.jobNumber,
        unit: e.unit?.name ?? null, unitAr: e.unit?.nameAr ?? null,
        position: e.position.title, positionAr: e.position.titleAr ?? null,
        emailHint: maskEmail(inv.email), expiresAt: inv.expiresAt,
      };
    },

    /** Public: creates the one account and links it to the employee (spec §3.2). */
    async claim(body: z.infer<typeof ClaimBody>, clientIp: string, requestId?: string) {
      await checkThrottle(clientIp);
      const passwordHash = await passwords.hash(body.password); // outside the locks
      try {
        return await db.$transaction(async (tx) => {
          const inv = await openInvitation(tx, body.token, true);
          if (!inv || !sameJobNumber(inv.employee.jobNumber, body.jobNumber) || inv.email !== body.email) throw invalid();
          await tx.$queryRaw`SELECT id FROM employees WHERE id = ${inv.employeeId} FOR UPDATE`;
          const { emp, reason } = await eligibility(tx, inv.employeeId);
          if (!emp || reason) throw invalid(); // e.g. the contract ended or an account appeared meanwhile
          if (await tx.user.findFirst({ where: { email: { equals: inv.email, mode: 'insensitive' } }, select: { id: true } })) throw invalid();
          const user = await tx.user.create({ data: { email: inv.email, displayName: emp.fullName, passwordHash, employeeId: emp.id }, select: { id: true } });
          await tx.invitation.update({ where: { id: inv.id }, data: { usedAt: new Date(), userId: user.id } });
          // New accounts get only the implicit staff self-service role (R1): no role rows.
          await appendAudit(tx, {
            actorUserId: user.id, action: 'ACCOUNT_CLAIMED', resource: 'user', resourceId: user.id,
            changes: { employeeId: emp.id, invitationId: inv.id, email: inv.email }, requestId,
          });
          return { userId: user.id };
        });
      } catch (e) {
        // A unique e-mail / employee link taken at the same instant is just another invalid claim.
        const err = (e as { code?: string }).code === 'P2002' ? invalid() : e;
        if (err instanceof HttpError && err.code === 'INVITATION_INVALID') await throttle.fail(`claim-ip:${clientIp}`);
        throw err;
      }
    },
  };
}

export type InvitationService = ReturnType<typeof createInvitationService>;
