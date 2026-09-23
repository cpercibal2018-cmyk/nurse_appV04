import { Router, type CookieOptions, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { HttpError } from '../../lib/http-errors.js';
import { PasswordSchema } from '../../lib/passwords.js';
import { constantTimeEqual } from '../../lib/tokens.js';
import { authOf } from '../../middleware/authorize.js';
import type { AuthService, IssuedSession } from './service.js';

export const REFRESH_COOKIE = 'nurseapp_refresh';
export const CSRF_COOKIE = 'nurseapp_csrf';
/** Spec §3.4: the refresh cookie is only ever sent to the auth endpoints. */
const REFRESH_PATH = '/api/v1/auth';

const LoginBody = z.strictObject({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) });
const PasswordBody = z.strictObject({ currentPassword: z.string().min(1).max(1024), newPassword: PasswordSchema });

export function createAuthRouter(env: Env, auth: AuthService, authenticate: RequestHandler) {
  const router = Router();
  const secure = env.NODE_ENV === 'production';

  const refreshCookie = (maxAgeSeconds: number): CookieOptions => ({ httpOnly: true, secure, sameSite: 'lax', path: REFRESH_PATH, maxAge: maxAgeSeconds * 1000 });
  // Readable by the SPA so it can echo the token after a reload (double submit on /refresh).
  const csrfCookie = (maxAgeSeconds: number): CookieOptions => ({ httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge: maxAgeSeconds * 1000 });

  function sendSession(res: Response, s: IssuedSession) {
    res.cookie(REFRESH_COOKIE, s.refreshCookie, refreshCookie(s.cookieMaxAge));
    res.cookie(CSRF_COOKIE, s.csrfToken, csrfCookie(s.cookieMaxAge));
    res.json({ token: s.token, csrfToken: s.csrfToken, expiresIn: s.expiresIn });
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

  // Login has no session yet, so no CSRF token exists; the Origin check stops
  // another site from signing a victim into an attacker's account (login CSRF).
  router.post('/login', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    const body = LoginBody.parse(req.body);
    try {
      sendSession(res, await auth.login(body.email, body.password, req.ip ?? 'unknown', res.locals.requestId));
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) {
        const d = e.details as { retryAfterSeconds?: number } | undefined;
        if (d?.retryAfterSeconds) res.set('Retry-After', String(d.retryAfterSeconds));
      }
      throw e;
    }
  });

  // Acts on a cookie, so it needs the CSRF defences itself (the access token
  // may already be expired): Origin must be the app, and the X-CSRF-Token
  // header must equal the CSRF cookie (double submit).
  router.post('/refresh', async (req, res) => {
    requireAppOrigin(req.get('origin'));
    requireCsrfCookieMatch(req.cookies as Record<string, string | undefined>, req.get('x-csrf-token'));
    try {
      sendSession(res, await auth.refresh((req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE], res.locals.requestId));
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
