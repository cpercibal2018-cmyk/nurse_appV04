// Password reset (decision D-50), by role:
//
// - SELF — "Forgot password?" on the sign-in page. Staff accounts only (no
//   active HR / Supervisor / System Admin assignment, not break-glass). The
//   answer is identical whether or not the address has an account, may self-
//   serve, or e-mail is off, so the endpoint reveals nothing. Link: 30 minutes.
// - ASSISTED — HR or a System Admin sends the link from Nursing Administration →
//   Accounts, within their account scope, after confirming who is asking. Any
//   active account except break-glass and the caller's own. Link: 24 hours.
//
// Both: 32 random bytes, only the SHA-256 stored, the token only in the e-mail
// (after "#", so never in a server log); single use; a new link revokes the
// open one. Completing it sets the password, signs out every session of the
// account and clears its sign-in attempt counter.

import crypto from 'node:crypto';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { renderEmail } from '../../lib/email-templates.js';
import { conflict, HttpError, notFound } from '../../lib/http-errors.js';
import { logger } from '../../lib/logger.js';
import { PasswordSchema, type PasswordService } from '../../lib/passwords.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import type { Throttle } from '../../lib/throttle.js';
import { assertEmployeeInScope } from './accounts.js';
import { activeGrants, unitScope, type AuthContext } from './access.js';

export const SELF_MINUTES = 30;
export const ASSISTED_HOURS = 24;
const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;

export const RequestResetBody = z.strictObject({ email: z.string().trim().toLowerCase().max(254) });
export const CompleteResetBody = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid token'), password: PasswordSchema });

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const invalid = () => new HttpError(400, 'PASSWORD_RESET_INVALID', 'This reset link is not valid or has expired. Request a new one.');
const tooMany = (wait: number) => new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts — try again later', { retryAfterSeconds: wait });

export interface PasswordResetDeps {
  db: Db;
  passwords: PasswordService;
  /** Per-client limit on the public endpoints. */
  clientThrottle: Throttle;
  /** Per-account limit on self-service requests; also the sign-in counter cleared on completion. */
  accountThrottle: Throttle;
  baseUrl: string;
  mailEnabled: boolean;
}

export function createPasswordResetService({ db, passwords, clientThrottle, accountThrottle, baseUrl, mailEnabled }: PasswordResetDeps) {
  async function blocked(key: string, throttle: Throttle) {
    const wait = await throttle.blockedFor(key);
    if (wait > 0) throw tooMany(wait);
  }

  /** Revokes the account's open link, stores a new one and queues the e-mail. */
  async function issue(tx: DbClient, user: { id: number; email: string }, mode: 'SELF' | 'ASSISTED', requestedById: number | null) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + (mode === 'SELF' ? SELF_MINUTES * 60_000 : ASSISTED_HOURS * 3600_000));
    await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const row = await tx.passwordReset.create({ data: { userId: user.id, mode, tokenHash: hashToken(token), requestedById, expiresAt }, select: { id: true } });
    const link = `${baseUrl.replace(/\/$/, '')}/reset-password#token=${token}`;
    const validity = mode === 'SELF' ? `${SELF_MINUTES} minutes` : `${ASSISTED_HOURS} hours`;
    const validityAr = mode === 'SELF' ? `${SELF_MINUTES} دقيقة` : `${ASSISTED_HOURS} ساعة`;
    const mail = renderEmail({
      title: 'Reset your AIGH Nursing Workforce password',
      message: `A password reset was requested for your account. Open the link below within ${validity} and choose a new password. The link works once, and all your current sessions will be signed out.\n\n${link}\n\nIf you did not ask for this, ignore this e-mail — your password stays the same — and tell HR.`,
      titleAr: 'إعادة تعيين كلمة المرور',
      messageAr: `طُلبت إعادة تعيين كلمة مرور حسابك. افتح الرابط التالي خلال ${validityAr} واختر كلمة مرور جديدة. يعمل الرابط مرة واحدة.\n\n${link}\n\nإذا لم تطلب ذلك فتجاهل هذه الرسالة وأبلغ الموارد البشرية.`,
    });
    await tx.emailOutbox.create({
      data: { toAddress: user.email, subject: mail.subject, bodyText: mail.text, bodyHtml: mail.html, priority: 'HIGH', eventKey: `password-reset:${row.id}` },
    });
    return { id: row.id, expiresAt };
  }

  return {
    /** Public, SELF. Always resolves the same way; see the header. */
    async request(body: z.infer<typeof RequestResetBody>, clientIp: string, requestId?: string) {
      await blocked(`reset-ip:${clientIp}`, clientThrottle);
      await blocked(`reset-acct:${body.email}`, accountThrottle);
      // Every request counts, found or not, so the limits say nothing about existence.
      await clientThrottle.fail(`reset-ip:${clientIp}`);
      await accountThrottle.fail(`reset-acct:${body.email}`);
      if (!mailEnabled) { logger.warn('password reset requested while e-mail is off', { requestId }); return; }
      const user = await db.user.findFirst({
        where: { email: { equals: body.email, mode: 'insensitive' } },
        select: { id: true, email: true, isActive: true, isBreakGlass: true },
      });
      if (!user || !user.isActive) return;
      const privileged = user.isBreakGlass || (await activeGrants(db, user.id)).length > 0;
      if (privileged) {
        // D-50: HR, supervisor, admin and break-glass accounts reset only through HR.
        await appendAudit(db, { actorUserId: null, action: 'PASSWORD_RESET_SELF_REFUSED', resource: 'user', resourceId: user.id, changes: { reason: user.isBreakGlass ? 'break_glass' : 'privileged_account' }, requestId });
        return;
      }
      await db.$transaction(async (tx) => {
        const r = await issue(tx, user, 'SELF', null);
        await appendAudit(tx, { actorUserId: null, action: 'PASSWORD_RESET_REQUESTED', resource: 'user', resourceId: user.id, changes: { mode: 'SELF', resetId: r.id, expiresAt: r.expiresAt.toISOString() }, requestId });
      });
    },

    /** HR / System Admin, ASSISTED: the link goes to the account's own e-mail, never to the caller. */
    async sendAssisted(auth: AuthContext, userId: number, requestId?: string) {
      if (!mailEnabled) throw conflict('EMAIL_OFF', 'Reset links are sent by e-mail, and e-mail is not configured (SMTP_HOST)');
      const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, isActive: true, isBreakGlass: true, employeeId: true } });
      if (!target) throw notFound('Account not found');
      if (target.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account is managed outside the application');
      if (target.id === auth.user.id) throw new HttpError(403, 'SELF_ACTION_FORBIDDEN', 'Use "Change password" for your own account');
      await assertEmployeeInScope(db, await unitScope(db, auth, ADMIN_ROLES), target.employeeId);
      if (!target.isActive) throw conflict('ACCOUNT_INACTIVE', 'Activate the account first');
      return db.$transaction(async (tx) => {
        const r = await issue(tx, target, 'ASSISTED', auth.user.id);
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'PASSWORD_RESET_REQUESTED', resource: 'user', resourceId: target.id, changes: { mode: 'ASSISTED', resetId: r.id, expiresAt: r.expiresAt.toISOString() }, requestId, priority: 'HIGH' });
        return { email: target.email, expiresAt: r.expiresAt };
      });
    },

    /** Public: sets the new password with a valid link. */
    async complete(body: z.infer<typeof CompleteResetBody>, clientIp: string, requestId?: string) {
      await blocked(`reset-ip:${clientIp}`, clientThrottle);
      const passwordHash = await passwords.hash(body.password); // outside the lock
      const h = hashToken(body.token);
      let email: string;
      try {
        email = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM password_resets WHERE token_hash = ${h} FOR UPDATE`;
          const r = await tx.passwordReset.findUnique({ where: { tokenHash: h }, include: { user: { select: { id: true, email: true, isActive: true, isBreakGlass: true } } } });
          if (!r || r.usedAt || r.revokedAt || r.expiresAt.getTime() <= Date.now() || !r.user.isActive || r.user.isBreakGlass) throw invalid();
          // A self-service link must not outlive a promotion to a privileged role.
          if (r.mode === 'SELF' && (await activeGrants(tx, r.userId)).length > 0) throw invalid();
          const now = new Date();
          await tx.user.update({ where: { id: r.userId }, data: { passwordHash } });
          await tx.passwordReset.update({ where: { id: r.id }, data: { usedAt: now } });
          await tx.refreshSession.updateMany({ where: { userId: r.userId, revokedAt: null }, data: { revokedAt: now } });
          await appendAudit(tx, { actorUserId: r.userId, action: 'PASSWORD_RESET_COMPLETED', resource: 'user', resourceId: r.userId, changes: { mode: r.mode, resetId: r.id }, requestId, priority: 'HIGH' });
          return r.user.email;
        });
      } catch (e) {
        if (e instanceof HttpError && e.code === 'PASSWORD_RESET_INVALID') await clientThrottle.fail(`reset-ip:${clientIp}`);
        throw e;
      }
      await accountThrottle.reset(`acct:${email.toLowerCase()}`); // the locked-out user can sign in at once
    },
  };
}

export type PasswordResetService = ReturnType<typeof createPasswordResetService>;
