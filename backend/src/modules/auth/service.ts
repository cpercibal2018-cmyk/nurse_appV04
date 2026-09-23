// Login, refresh rotation, logout, password change and the break-glass siren
// (spec §3.3, §3.4, §3.6; ported from V03 server/src/index.ts auth routes).

import type { Env } from '../../config/env.js';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import type { PasswordService } from '../../lib/passwords.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import type { Throttle } from '../../lib/throttle.js';
import { constantTimeEqual, randomToken, sha256hex, type TokenService } from '../../lib/tokens.js';
import { activeBreakGlass, activeGrants, activePam, effectiveGrants, effectiveRoles, type AuthContext } from '../users/access.js';

/** Spec §3.6: a break-glass session is limited to 4 hours. */
export const BREAK_GLASS_SESSION_SECONDS = 4 * 3600;

export interface AuthDeps {
  db: Db;
  env: Env;
  tokens: TokenService;
  passwords: PasswordService;
  accountThrottle: Throttle;
  clientThrottle: Throttle;
}

export interface IssuedSession {
  /** Cookie value "<sessionId>.<secret>"; only sha256(secret) is stored. */
  refreshCookie: string;
  csrfToken: string;
  token: string;
  expiresIn: number;
  /** Seconds until the absolute boundary — the cookies' max age. */
  cookieMaxAge: number;
}

/** Where a request came from; stored on the session row for the owner's history (D-22). */
export interface ClientMeta { ip: string; userAgent?: string }

const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
const sessionEnded = () => new HttpError(401, 'SESSION_EXPIRED', 'Your session has ended — sign in again');

export function createAuthService(deps: AuthDeps) {
  const { db, env, tokens, passwords } = deps;

  async function issue(tx: DbClient, userId: number, family: string, idleUntil: Date, absoluteUntil: Date, now: Date, meta: ClientMeta): Promise<IssuedSession> {
    const id = randomToken(16);
    const secret = randomToken(32);
    const expiresAt = new Date(Math.min(idleUntil.getTime(), absoluteUntil.getTime()));
    await tx.refreshSession.create({
      data: { id, userId, tokenHash: sha256hex(secret), familyId: family, expiresAt, absoluteExpiresAt: absoluteUntil, ipAddress: meta.ip.slice(0, 45), userAgent: meta.userAgent?.slice(0, 300) ?? null },
    });
    const csrfToken = randomToken(24);
    return {
      refreshCookie: `${id}.${secret}`,
      csrfToken,
      token: tokens.sign({ sub: userId, sid: family, csrf: sha256hex(csrfToken) }, now.getTime()),
      expiresIn: tokens.ttlSeconds,
      cookieMaxAge: Math.max(0, Math.floor((absoluteUntil.getTime() - now.getTime()) / 1000)),
    };
  }

  async function login(emailRaw: string, password: string, clientIp: string, requestId?: string, userAgent?: string) {
    const email = emailRaw.trim().toLowerCase();
    const accountKey = `acct:${email}`;
    const clientKey = `ip:${clientIp}`;
    const wait = Math.max(deps.accountThrottle.blockedFor(accountKey), deps.clientThrottle.blockedFor(clientKey));
    if (wait > 0) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts — try again later', { retryAfterSeconds: wait });

    const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    const ok = await passwords.verify(password, user?.passwordHash);

    if (!user || !ok || !user.isActive) {
      deps.accountThrottle.fail(accountKey);
      deps.clientThrottle.fail(clientKey);
      // Audited only for a real account: an unknown email is not personal data we hold.
      if (user) {
        await appendAudit(db, {
          actorUserId: null, action: 'LOGIN_FAILED', resource: 'user', resourceId: String(user.id),
          changes: { reason: !ok ? 'bad_password' : 'inactive' }, requestId, priority: user.isBreakGlass ? 'HIGH' : 'NORMAL',
        });
      }
      throw invalidCredentials();
    }
    deps.accountThrottle.reset(accountKey);

    const now = new Date();
    const absoluteSeconds = user.isBreakGlass ? Math.min(BREAK_GLASS_SESSION_SECONDS, env.SESSION_ABSOLUTE_SECONDS) : env.SESSION_ABSOLUTE_SECONDS;
    return db.$transaction(async (tx) => {
      if (user.isBreakGlass) await sirenOnLogin(tx, user.id, clientIp, now, absoluteSeconds, requestId);
      const session = await issue(tx, user.id, randomToken(16), new Date(now.getTime() + env.SESSION_IDLE_SECONDS * 1000), new Date(now.getTime() + absoluteSeconds * 1000), now, { ip: clientIp, userAgent });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      await appendAudit(tx, { actorUserId: user.id, action: 'LOGIN_SUCCEEDED', resource: 'user', resourceId: String(user.id), requestId, priority: user.isBreakGlass ? 'HIGH' : 'NORMAL' });
      return session;
    });
  }

  /**
   * Break-glass siren (spec §3.6, decision D-9 minimal): irrevocable event row,
   * HIGH audit entry and a CRITICAL in-app notification to every System Admin.
   * SMS/email to the CEO and IT Director is NOT built (no SMTP/SMS decided).
   */
  async function sirenOnLogin(tx: DbClient, userId: number, ip: string, now: Date, seconds: number, requestId?: string) {
    const event = await tx.breakGlassEvent.create({
      data: { actorUserId: userId, reason: 'Break-glass account sign-in', ipAddress: ip, activatedAt: now, expiresAt: new Date(now.getTime() + seconds * 1000) },
    });
    await appendAudit(tx, { actorUserId: userId, action: 'BREAK_GLASS_ACTIVATED', resource: 'break_glass_event', resourceId: String(event.id), changes: { ipAddress: ip, expiresAt: event.expiresAt.toISOString() }, requestId, priority: 'HIGH' });
    const admins = await tx.roleAssignment.findMany({
      where: { role: 'SYSTEM_ADMIN', revokedAt: null, userId: { not: userId }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { userId: true }, distinct: ['userId'],
    });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((a) => ({
          recipientId: a.userId, type: 'SECURITY' as const, priority: 'CRITICAL' as const,
          title: 'Break-glass account activated',
          message: `The break-glass account signed in from ${ip}. The session ends at ${event.expiresAt.toISOString()} (UTC).`,
          titleAr: 'تم تفعيل حساب الطوارئ',
          messageAr: `تم تسجيل الدخول بحساب الطوارئ من ${ip}.`,
          eventKey: `break-glass:${event.id}`,
        })),
        skipDuplicates: true,
      });
    }
  }

  /**
   * Rotate the refresh token. The presented token is consumed atomically; a
   * token that was already consumed is treated as theft and the whole family
   * is revoked (spec §3.3 "consumed atomically — replay is rejected").
   */
  async function refresh(cookieValue: string | undefined, requestId?: string, meta: ClientMeta = { ip: 'unknown' }): Promise<IssuedSession> {
    const [id, secret] = (cookieValue ?? '').split('.');
    if (!id || !secret) throw sessionEnded();
    const session = await db.refreshSession.findUnique({ where: { id } });
    if (!session || !constantTimeEqual(session.tokenHash, sha256hex(secret))) throw sessionEnded();

    const now = new Date();
    const revokeFamily = () => db.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: now } });

    if (session.revokedAt) {
      await revokeFamily();
      await appendAudit(db, { actorUserId: session.userId, action: 'REFRESH_TOKEN_REUSE', resource: 'user', resourceId: String(session.userId), requestId, priority: 'HIGH' });
      throw new HttpError(401, 'SESSION_REVOKED', 'This session was ended for your protection — sign in again');
    }
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) throw sessionEnded();

    const user = await db.user.findUnique({ where: { id: session.userId } });
    if (!user?.isActive) { await revokeFamily(); throw sessionEnded(); }
    if (user.isBreakGlass && !(await activeBreakGlass(db, user.id, now))) { await revokeFamily(); throw sessionEnded(); }

    return db.$transaction(async (tx) => {
      const consumed = await tx.refreshSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } });
      if (consumed.count !== 1) throw new HttpError(401, 'SESSION_REVOKED', 'This session was ended for your protection — sign in again');
      return issue(tx, user.id, session.familyId, new Date(now.getTime() + env.SESSION_IDLE_SECONDS * 1000), session.absoluteExpiresAt, now, meta);
    });
  }

  /** Ends the whole session family, so access tokens minted from it stop working at once. */
  async function logout(cookieValue: string | undefined, requestId?: string) {
    const [id] = (cookieValue ?? '').split('.');
    if (!id) return;
    const session = await db.refreshSession.findUnique({ where: { id } });
    if (!session) return;
    await db.$transaction(async (tx) => {
      await tx.refreshSession.updateMany({ where: { familyId: session.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      await appendAudit(tx, { actorUserId: session.userId, action: 'LOGOUT', resource: 'user', resourceId: String(session.userId), requestId });
    });
  }

  /** Spec §3.3: verifies the current password and revokes all active sessions. */
  async function changePassword(auth: AuthContext, current: string, next: string, requestId?: string) {
    const accountKey = `acct:${auth.user.email.toLowerCase()}`;
    if (deps.accountThrottle.blockedFor(accountKey) > 0) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts — try again later');
    const user = await db.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    if (!(await passwords.verify(current, user.passwordHash))) {
      deps.accountThrottle.fail(accountKey);
      throw new HttpError(400, 'CURRENT_PASSWORD_WRONG', 'The current password is not correct');
    }
    if (current === next) throw new HttpError(400, 'PASSWORD_UNCHANGED', 'Choose a password different from the current one');
    const passwordHash = await passwords.hash(next);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await appendAudit(tx, { actorUserId: user.id, action: 'PASSWORD_CHANGED', resource: 'user', resourceId: String(user.id), requestId, priority: 'HIGH' });
    });
  }

  /** GET /auth/me — identity, stored grants, what is usable now, PAM and break-glass state. */
  async function me(auth: AuthContext) {
    const now = new Date();
    const [grants, pam, breakGlass] = await Promise.all([
      activeGrants(db, auth.user.id, now), activePam(db, auth.user.id, now),
      auth.user.isBreakGlass ? activeBreakGlass(db, auth.user.id, now) : Promise.resolve(null),
    ]);
    const effective = effectiveGrants(grants, pam, breakGlass);
    return {
      user: auth.user,
      roles: grants.map((g) => ({ ...g, dormant: g.role === 'SYSTEM_ADMIN' && !pam && !breakGlass })),
      effectiveRoles: effectiveRoles({ ...auth, effective }),
      pam: pam ? { expiresAt: pam.expiresAt } : null,
      breakGlass: breakGlass ? { expiresAt: breakGlass.expiresAt } : null,
    };
  }

  /**
   * D-22: the caller's own sign-ins, newest first. One entry per session
   * family (a sign-in and its refreshes): where it started, where it was last
   * refreshed, and whether it can still be used.
   */
  async function sessions(auth: AuthContext, now = new Date()) {
    const rows = await db.refreshSession.findMany({
      where: { userId: auth.user.id },
      select: { familyId: true, createdAt: true, expiresAt: true, absoluteExpiresAt: true, revokedAt: true, ipAddress: true, userAgent: true },
      orderBy: { createdAt: 'asc' },
    });
    const families = new Map<string, typeof rows>();
    for (const r of rows) families.set(r.familyId, [...(families.get(r.familyId) ?? []), r]);
    const items = [...families.entries()].map(([familyId, list]) => {
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = list.some((r) => !r.revokedAt && r.expiresAt > now && r.absoluteExpiresAt > now);
      return {
        current: familyId === auth.sessionFamily, active,
        signedInAt: first.createdAt, lastActiveAt: last.createdAt, endsBy: first.absoluteExpiresAt,
        signInIp: first.ipAddress, signInUserAgent: first.userAgent, lastIp: last.ipAddress, lastUserAgent: last.userAgent,
      };
    }).sort((a, b) => b.signedInAt.getTime() - a.signedInAt.getTime()).slice(0, 50);
    return { items, total: items.length };
  }

  return { login, refresh, logout, changePassword, me, sessions };
}

export type AuthService = ReturnType<typeof createAuthService>;
