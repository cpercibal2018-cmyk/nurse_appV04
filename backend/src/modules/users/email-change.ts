// Changing an account's sign-in e-mail (decision D-67). The e-mail is the
// sign-in name and where reset links go, so a change is never instant:
//
// - SELF — My account → Security: the current password, then a link to the
//   NEW address. A hijacked session alone cannot move the account.
// - ASSISTED — HR or an elevated System Admin, for an active account in their
//   scope (never break-glass, never their own: they use SELF). No password;
//   HR confirms who is asking, as for an assisted password reset (D-50).
//
// Both: the link (30 minutes, single use, 32 random bytes, SHA-256 stored, the
// token after "#" so never in a server log) goes to the new address, which
// proves it is reachable and spelled right; the OLD address is warned at once.
// Confirming re-checks that the address is still free, switches the e-mail,
// signs out every session of the account, audits HIGH, and tells the old
// address it happened. A new request revokes the open one. E-mail must be on.

import crypto from 'node:crypto';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { renderEmail } from '../../lib/email-templates.js';
import { conflict, HttpError, notFound } from '../../lib/http-errors.js';
import type { PasswordService } from '../../lib/passwords.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import type { Throttle } from '../../lib/throttle.js';
import { assertEmployeeInScope } from './accounts.js';
import { unitScope, type AuthContext } from './access.js';

export const EMAIL_CHANGE_MINUTES = 30;
const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;

// Trimmed and lower-cased before the format check, so a pasted " New@Mail.sa " is accepted.
const NewEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const RequestOwnEmailChangeBody = z.strictObject({ newEmail: NewEmail, currentPassword: z.string().min(1).max(200) });
export const RequestEmailChangeBody = z.strictObject({ newEmail: NewEmail });
export const ConfirmEmailChangeBody = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid token') });

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const invalid = () => new HttpError(400, 'EMAIL_CHANGE_INVALID', 'This confirmation link is not valid or has expired. Request the change again.');
const tooMany = (wait: number) => new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts — try again later', { retryAfterSeconds: wait });
const emailInUse = () => conflict('EMAIL_IN_USE', 'Another account already uses this e-mail address');

/** "a•••@example.sa": enough for the owner to recognise, not a full address in someone else's mailbox. */
export const maskEmail = (e: string) => { const [local = '', domain = ''] = e.split('@'); return `${local.slice(0, 1)}•••@${domain}`; };

export interface EmailChangeDeps {
  db: Db;
  passwords: PasswordService;
  /** Per-client limit on the public confirm endpoint. */
  clientThrottle: Throttle;
  /** The sign-in counter (acct:<email>): wrong current passwords count here too. */
  accountThrottle: Throttle;
  baseUrl: string;
  mailEnabled: boolean;
}

export function createEmailChangeService({ db, passwords, clientThrottle, accountThrottle, baseUrl, mailEnabled }: EmailChangeDeps) {
  async function assertFree(tx: DbClient, newEmail: string, userId: number) {
    const other = await tx.user.findFirst({ where: { email: { equals: newEmail, mode: 'insensitive' }, id: { not: userId } }, select: { id: true } });
    if (other) throw emailInUse();
  }

  function mail(to: string, title: string, message: string, titleAr: string, messageAr: string, eventKey: string) {
    const m = renderEmail({ title, message, titleAr, messageAr });
    return { toAddress: to, subject: m.subject, bodyText: m.text, bodyHtml: m.html, priority: 'HIGH' as const, eventKey };
  }

  /** Revokes the open request, stores a new one, e-mails the link to the new address and a warning to the old. */
  async function issue(tx: DbClient, user: { id: number; email: string }, newEmail: string, mode: 'SELF' | 'ASSISTED', requestedById: number) {
    if (newEmail === user.email.toLowerCase()) throw new HttpError(400, 'EMAIL_UNCHANGED', 'This is already the account\'s e-mail address');
    await assertFree(tx, newEmail, user.id);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_MINUTES * 60_000);
    await tx.emailChange.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const row = await tx.emailChange.create({ data: { userId: user.id, mode, oldEmail: user.email, newEmail, tokenHash: hashToken(token), requestedById, expiresAt }, select: { id: true } });
    const link = `${baseUrl.replace(/\/$/, '')}/confirm-email#token=${token}`;
    await tx.emailOutbox.createMany({
      data: [
        mail(newEmail, 'Confirm your new AIGH Nursing Workforce sign-in e-mail',
          `A request was made to use this address to sign in to AIGH Nursing Workforce. Open the link below within ${EMAIL_CHANGE_MINUTES} minutes to confirm. Until then nothing changes. After confirming, sign in with this address; all current sessions are signed out.\n\n${link}\n\nIf you did not expect this, ignore this e-mail.`,
          'تأكيد البريد الإلكتروني الجديد لتسجيل الدخول',
          `طُلب استخدام هذا العنوان لتسجيل الدخول إلى نظام القوى العاملة التمريضية. افتح الرابط التالي خلال ${EMAIL_CHANGE_MINUTES} دقيقة للتأكيد. لن يتغير شيء قبل ذلك.\n\n${link}\n\nإذا لم تتوقع هذه الرسالة فتجاهلها.`,
          `email-change:${row.id}:confirm`),
        mail(user.email, 'A change of your sign-in e-mail was requested',
          `A request was made to change the sign-in e-mail of your AIGH Nursing Workforce account to ${maskEmail(newEmail)}. It takes effect only if confirmed from that address within ${EMAIL_CHANGE_MINUTES} minutes. If this was not you, change your password and tell HR at once.`,
          'طُلب تغيير البريد الإلكتروني لتسجيل الدخول',
          `طُلب تغيير البريد الإلكتروني لحسابك إلى ${maskEmail(newEmail)}. لا يسري التغيير إلا بعد تأكيده من ذلك العنوان. إذا لم تطلب ذلك فغيّر كلمة المرور وأبلغ الموارد البشرية فوراً.`,
          `email-change:${row.id}:warn`),
      ],
    });
    return { id: row.id, expiresAt };
  }

  function requireMail() {
    if (!mailEnabled) throw conflict('EMAIL_OFF', 'The new address is confirmed by e-mail, and e-mail is not configured (SMTP_HOST)');
  }

  return {
    /** SELF: the signed-in account, with its current password. */
    async requestOwn(auth: AuthContext, body: z.infer<typeof RequestOwnEmailChangeBody>, requestId?: string) {
      requireMail();
      if (auth.user.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account is managed outside the application');
      const accountKey = `acct:${auth.user.email.toLowerCase()}`;
      const wait = await accountThrottle.blockedFor(accountKey);
      if (wait > 0) throw tooMany(wait);
      const user = await db.user.findUniqueOrThrow({ where: { id: auth.user.id }, select: { id: true, email: true, passwordHash: true } });
      if (!(await passwords.verify(body.currentPassword, user.passwordHash))) {
        await accountThrottle.fail(accountKey);
        await appendAudit(db, { actorUserId: user.id, action: 'EMAIL_CHANGE_PASSWORD_WRONG', resource: 'user', resourceId: user.id, requestId, priority: 'HIGH' });
        throw new HttpError(400, 'CURRENT_PASSWORD_WRONG', 'The current password is not correct');
      }
      return db.$transaction(async (tx) => {
        const r = await issue(tx, user, body.newEmail, 'SELF', user.id);
        await appendAudit(tx, { actorUserId: user.id, action: 'EMAIL_CHANGE_REQUESTED', resource: 'user', resourceId: user.id, changes: { mode: 'SELF', changeId: r.id, newEmail: maskEmail(body.newEmail), expiresAt: r.expiresAt.toISOString() }, requestId, priority: 'HIGH' });
        return { pendingEmail: body.newEmail, expiresAt: r.expiresAt };
      });
    },

    /** ASSISTED: HR / System Admin for an account in scope. */
    async requestFor(auth: AuthContext, userId: number, body: z.infer<typeof RequestEmailChangeBody>, requestId?: string) {
      requireMail();
      const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, isActive: true, isBreakGlass: true, employeeId: true } });
      if (!target) throw notFound('Account not found');
      if (target.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account is managed outside the application');
      if (target.id === auth.user.id) throw new HttpError(403, 'SELF_ACTION_FORBIDDEN', 'Change your own e-mail in My account → Security');
      await assertEmployeeInScope(db, await unitScope(db, auth, ADMIN_ROLES), target.employeeId);
      if (!target.isActive) throw conflict('ACCOUNT_INACTIVE', 'Activate the account first');
      return db.$transaction(async (tx) => {
        const r = await issue(tx, target, body.newEmail, 'ASSISTED', auth.user.id);
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'EMAIL_CHANGE_REQUESTED', resource: 'user', resourceId: target.id, changes: { mode: 'ASSISTED', changeId: r.id, newEmail: maskEmail(body.newEmail), expiresAt: r.expiresAt.toISOString() }, requestId, priority: 'HIGH' });
        return { pendingEmail: body.newEmail, expiresAt: r.expiresAt };
      });
    },

    /** The signed-in account's open request, if any. */
    async pending(auth: AuthContext) {
      const r = await db.emailChange.findFirst({ where: { userId: auth.user.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { newEmail: true, expiresAt: true, mode: true } });
      return { email: auth.user.email, pending: r ? { newEmail: r.newEmail, expiresAt: r.expiresAt, mode: r.mode } : null, available: !auth.user.isBreakGlass };
    },

    async cancelOwn(auth: AuthContext, requestId?: string) {
      const { count } = await db.emailChange.updateMany({ where: { userId: auth.user.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      if (!count) throw conflict('EMAIL_CHANGE_NONE', 'No e-mail change is waiting');
      await appendAudit(db, { actorUserId: auth.user.id, action: 'EMAIL_CHANGE_CANCELLED', resource: 'user', resourceId: auth.user.id, requestId });
    },

    /** Public: the link from the new address. */
    async confirm(body: z.infer<typeof ConfirmEmailChangeBody>, clientIp: string, requestId?: string) {
      const ipKey = `email-change-ip:${clientIp}`;
      const wait = await clientThrottle.blockedFor(ipKey);
      if (wait > 0) throw tooMany(wait);
      const h = hashToken(body.token);
      try {
        return await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM email_changes WHERE token_hash = ${h} FOR UPDATE`;
          const r = await tx.emailChange.findUnique({ where: { tokenHash: h }, include: { user: { select: { id: true, email: true, isActive: true, isBreakGlass: true } } } });
          if (!r || r.usedAt || r.revokedAt || r.expiresAt.getTime() <= Date.now() || !r.user.isActive || r.user.isBreakGlass) throw invalid();
          // The account's e-mail changed another way since the request: the request is stale.
          if (r.user.email.toLowerCase() !== r.oldEmail.toLowerCase()) throw invalid();
          await assertFree(tx, r.newEmail, r.userId);
          const now = new Date();
          await tx.user.update({ where: { id: r.userId }, data: { email: r.newEmail } });
          await tx.emailChange.update({ where: { id: r.id }, data: { usedAt: now } });
          await tx.refreshSession.updateMany({ where: { userId: r.userId, revokedAt: null }, data: { revokedAt: now } });
          await appendAudit(tx, { actorUserId: r.userId, action: 'EMAIL_CHANGED', resource: 'user', resourceId: r.userId, changes: { mode: r.mode, changeId: r.id, from: maskEmail(r.oldEmail), to: maskEmail(r.newEmail), requestedById: r.requestedById }, requestId, priority: 'HIGH' });
          await tx.emailOutbox.create({
            data: mail(r.oldEmail, 'Your sign-in e-mail was changed',
              `The sign-in e-mail of your AIGH Nursing Workforce account is now ${maskEmail(r.newEmail)}, and every session was signed out. If this was not you, tell HR at once.`,
              'تم تغيير البريد الإلكتروني لتسجيل الدخول',
              `أصبح البريد الإلكتروني لتسجيل الدخول إلى حسابك ${maskEmail(r.newEmail)}، وتم تسجيل الخروج من جميع الجلسات. إذا لم تقم بذلك فأبلغ الموارد البشرية فوراً.`,
              `email-change:${r.id}:done`),
          });
          return { email: r.newEmail };
        });
      } catch (e) {
        if (e instanceof HttpError && e.code === 'EMAIL_CHANGE_INVALID') await clientThrottle.fail(ipKey);
        // Two requests for one address, confirmed at the same moment: the unique index decides.
        if ((e as { code?: string }).code === 'P2002') throw emailInUse();
        throw e;
      }
    },
  };
}

export type EmailChangeService = ReturnType<typeof createEmailChangeService>;
