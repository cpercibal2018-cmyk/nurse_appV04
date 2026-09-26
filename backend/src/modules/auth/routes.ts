import { Router, type CookieOptions, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { HttpError } from '../../lib/http-errors.js';
import { PasswordSchema } from '../../lib/passwords.js';
import { constantTimeEqual } from '../../lib/tokens.js';
import { authOf } from '../../middleware/authorize.js';
import type { AuthService, IssuedSession } from './service.js';
import type { MfaService } from './mfa.js';
import { ClaimBody, PreviewBody, type InvitationService } from '../users/invitations.js';
import { CompleteResetBody, RequestResetBody, type PasswordResetService } from '../users/password-reset.js';
import { ConfirmEmailChangeBody, type EmailChangeService } from '../users/email-change.js';

export const REFRESH_COOKIE = 'nurseapp_refresh';
export const CSRF_COOKIE = 'nurseapp_csrf';
/** Spec §3.4: the refresh cookie is only ever sent to the auth endpoints. */
const REFRESH_PATH = '/api/v1/auth';

const LoginBody = z.strictObject({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) });
const PasswordBody = z.strictObject({ currentPassword: z.string().min(1).max(1024), newPassword: PasswordSchema });
const Challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid challenge');
/** A 6-digit authenticator code or a recovery code (XXXXX-XXXXX). */
const Code = z.string().trim().min(6).max(16);
const MfaChallengeBody = z.strictObject({ challenge: Challenge });
const MfaCodeBody = z.strictObject({ challenge: Challenge, code: Code });
const CodeBody = z.strictObject({ code: Code });

export function createAuthRouter(env: Env, auth: AuthService, authenticate: RequestHandler, invitations: InvitationService, resets: PasswordResetService, mfa: MfaService, emailChanges: EmailChangeService) {
  const router = Router();
  const secure = env.NODE_ENV === 'production';

  const refreshCookie = (maxAgeSeconds: number): CookieOptions => ({ httpOnly: true, secure, sameSite: 'lax', path: REFRESH_PATH, maxAge: maxAgeSeconds * 1000 });
  // Readable by the SPA so it can echo the token after a reload (double submit on /refresh).
  const csrfCookie = (maxAgeSeconds: number): CookieOptions => ({ httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge: maxAgeSeconds * 1000 });

  function sendSession(res: Response, s: IssuedSession, extra: object = {}) {
    res.cookie(REFRESH_COOKIE, s.refreshCookie, refreshCookie(s.cookieMaxAge));
    res.cookie(CSRF_COOKIE, s.csrfToken, csrfCookie(s.cookieMaxAge));
    res.json({ token: s.token, csrfToken: s.csrfToken, expiresIn: s.expiresIn, ...extra });
  }
  function clearSession(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH, secure, sameSite: 'lax', httpOnly: true });
    res.clearCookie(CSRF_COOKIE, { path: '/', secure, sameSite: 'lax' });
  }

  const requireAppOrigin = (origin: string | undefined) => {
    if (origin !== env.CORS_ORIGIN) throw new HttpError(403, 'ORIGIN_REJECTED', 'Request origin not allowed');
  };
  /** Double submit: the X-CSRF-Token header must equal the readable CSRF cookie. */
  const requireCsrfCookieMatch = (cookies: Record<string, string | undefined>, header: string | undefined) => {
    const cookieToken = cookies[CSRF_COOKIE] ?? '';
    if (!cookieToken || !header || !constantTimeEqual(cookieToken, header)) throw new HttpError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token');
  };

  const withRetryAfter = async <T,>(res: Response, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        const d = e.details as { retryAfterSeconds?: number } | undefined;
        if (d?.retryAfterSeconds) res.set('Retry-After', String(d.retryAfterSeconds));
      }
      throw e;
    }
  };

  // Registration by invitation (spec §3.2): no session exists yet, so — like
  // login — the Origin check stands in for CSRF protection.
  router.post('/invitations/preview', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    res.json(await withRetryAfter(res, () => invitations.preview(PreviewBody.parse(req.body), req.ip ?? 'unknown')));
  });
  router.post('/invitations/claim', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    res.status(201).json(await withRetryAfter(res, () => invitations.claim(ClaimBody.parse(req.body), req.ip ?? 'unknown', res.locals.requestId)));
  });

  // Password reset (D-50). "request" answers 202 whatever the address, so it
  // reveals nothing; only staff accounts get a self-service link.
  router.post('/password-reset/request', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    await withRetryAfter(res, () => resets.request(RequestResetBody.parse(req.body), req.ip ?? 'unknown', res.locals.requestId));
    res.status(202).json({ accepted: true });
  });
  router.post('/password-reset/complete', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    await withRetryAfter(res, () => resets.complete(CompleteResetBody.parse(req.body), req.ip ?? 'unknown', res.locals.requestId));
    res.status(204).end();
  });

  // Sign-in e-mail change (D-67): the link from the new address; the token is the credential.
  router.post('/email-change/confirm', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    res.json(await withRetryAfter(res, () => emailChanges.confirm(ConfirmEmailChangeBody.parse(req.body), req.ip ?? 'unknown', res.locals.requestId)));
  });

  // Login has no session yet, so no CSRF token exists; the Origin check stops
  // another site from signing a victim into an attacker's account (login CSRF).
  router.post('/login', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    const body = LoginBody.parse(req.body);
    const out = await withRetryAfter(res, () => auth.login(body.email, body.password, req.ip ?? 'unknown', res.locals.requestId, req.get('user-agent')));
    // Spec §3.5: with a second step pending, no cookie is set — only the challenge.
    if ('mfa' in out) res.json(out);
    else sendSession(res, out);
  });

  // The second sign-in step (spec §3.5). Like login, no session exists yet: the
  // Origin check and the single-use challenge stand in for CSRF protection.
  router.post('/mfa/verify', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    const body = MfaCodeBody.parse(req.body);
    sendSession(res, await withRetryAfter(res, () => auth.mfaVerify(body.challenge, body.code, req.ip ?? 'unknown', res.locals.requestId, req.get('user-agent'))));
  });
  router.post('/mfa/enroll/start', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    res.json(await withRetryAfter(res, () => auth.mfaEnrollStart(MfaChallengeBody.parse(req.body).challenge, req.ip ?? 'unknown')));
  });
  router.post('/mfa/enroll/confirm', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    const body = MfaCodeBody.parse(req.body);
    const out = await withRetryAfter(res, () => auth.mfaEnrollConfirm(body.challenge, body.code, req.ip ?? 'unknown', res.locals.requestId, req.get('user-agent')));
    sendSession(res, out.session, { recoveryCodes: out.recoveryCodes });
  });

  // Signed-in self-service: status, optional set-up, recovery codes, turning it off.
  router.get('/mfa', authenticate, async (_req, res) => {
    res.json(await mfa.status(authOf(res)));
  });
  router.post('/mfa/setup', authenticate, async (_req, res) => {
    res.json(await mfa.setupSelf(authOf(res), res.locals.requestId));
  });
  router.post('/mfa/setup/confirm', authenticate, async (req, res) => {
    res.json(await mfa.confirmSelf(authOf(res), CodeBody.parse(req.body).code, res.locals.requestId));
  });
  router.post('/mfa/recovery-codes', authenticate, async (req, res) => {
    res.json(await mfa.regenerateCodes(authOf(res), CodeBody.parse(req.body).code, res.locals.requestId));
  });
  router.post('/mfa/disable', authenticate, async (req, res) => {
    await mfa.disableSelf(authOf(res), CodeBody.parse(req.body).code, res.locals.requestId);
    res.status(204).end();
  });

  // Acts on a cookie, so it needs the CSRF defences itself (the access token
  // may already be expired): Origin must be the app, and the X-CSRF-Token
  // header must equal the CSRF cookie (double submit).
  router.post('/refresh', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    requireCsrfCookieMatch(req.cookies as Record<string, string | undefined>, req.get('x-csrf-token'));
    try {
      sendSession(res, await auth.refresh((req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE], res.locals.requestId, { ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') }));
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) clearSession(res);
      throw e;
    }
  });

  // Spec §3.4: every state-changing request carries the CSRF token — logout too.
  router.post('/logout', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    requireCsrfCookieMatch(req.cookies as Record<string, string | undefined>, req.get('x-csrf-token'));
    await auth.logout((req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE], res.locals.requestId);
    clearSession(res);
    res.status(204).end();
  });

  // D-22: own login/session history only.
  router.get('/sessions', authenticate, async (_req, res) => {
    res.json(await auth.sessions(authOf(res)));
  });

  router.get('/me', authenticate, async (_req, res) => {
    res.json(await auth.me(authOf(res)));
  });

  router.post('/password', authenticate, async (req, res) => {
    const body = PasswordBody.parse(req.body);
    await auth.changePassword(authOf(res), body.currentPassword, body.newPassword, res.locals.requestId);
    clearSession(res);
    res.status(204).end();
  });

  return router;
}
