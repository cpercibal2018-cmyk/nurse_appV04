// Authentication for every protected route (spec §3.3, §3.4):
//   1. a valid, unexpired HS256 access token (Bearer header, never a cookie);
//   2. an active account and a live session family — logout, password change
//      or deactivation ends existing access tokens immediately;
//   3. break-glass sessions end at their 4-hour cap (R18);
//   4. state-changing requests carry the session's CSRF token and, per the
//      spec's CsrfGuard, an Origin equal to the application origin.
// A FHIR read may instead carry another system's client token (D-63): it sets
// res.locals.client, never res.locals.auth, and is refused on any other path.

import type { RequestHandler } from 'express';
import { constantTimeEqual, sha256hex, TokenError, type TokenService } from '../lib/tokens.js';
import type { Db } from '../lib/prisma.js';
import { HttpError, unauthorized } from '../lib/http-errors.js';
import { activeBreakGlass, activeGrants, activePam, effectiveGrants } from '../modules/users/access.js';
import type { ClientAuth } from '../modules/interop/api-clients.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createAuthenticate(db: Db, tokens: TokenService, appOrigin: string, clients?: ClientAuth): RequestHandler {
  return async (req, res, next) => {
    const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(req.get('authorization') ?? '');
    if (!match?.[1]) return next(unauthorized());

    // Another system's token: FHIR reads only (signed with its own key, so it never verifies as a user token).
    if (clients && req.path.startsWith('/fhir/')) {
      const client = await clients.authenticate(match[1]);
      if (client === 'ended') return next(unauthorized('This API client was revoked or its secret replaced — request a new token'));
      if (client) {
        if (!SAFE_METHODS.has(req.method)) return next(new HttpError(403, 'FORBIDDEN', 'API clients can only read'));
        res.locals.client = client;
        return next();
      }
    }

    let claims;
    try {
      claims = tokens.verify(match[1]);
    } catch (e) {
      // The reason (expired vs forged) is deliberately not disclosed.
      if (e instanceof TokenError) return next(unauthorized('Session expired or invalid — sign in again'));
      throw e;
    }

    const now = new Date();
    const [user, liveSession] = await Promise.all([
      db.user.findUnique({ where: { id: claims.sub } }),
      db.refreshSession.findFirst({
        where: { familyId: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
        select: { id: true },
      }),
    ]);
    if (!user || !user.isActive || !liveSession) return next(unauthorized('Session expired or invalid — sign in again'));

    const breakGlass = user.isBreakGlass ? await activeBreakGlass(db, user.id, now) : null;
    if (user.isBreakGlass && !breakGlass) return next(unauthorized('Break-glass session has ended'));

    if (!SAFE_METHODS.has(req.method)) {
      if (req.get('origin') !== appOrigin) return next(new HttpError(403, 'ORIGIN_REJECTED', 'Request origin not allowed'));
      const header = req.get('x-csrf-token') ?? '';
      if (!header || !constantTimeEqual(sha256hex(header), claims.csrf)) {
        return next(new HttpError(403, 'CSRF_FAILED', 'Missing or invalid CSRF token'));
      }
    }

    const [grants, pam] = await Promise.all([activeGrants(db, user.id, now), activePam(db, user.id, now)]);
    res.locals.auth = {
      user: { id: user.id, email: user.email, displayName: user.displayName, employeeId: user.employeeId, isBreakGlass: user.isBreakGlass },
      sessionFamily: claims.sid,
      csrfHash: claims.csrf,
      grants,
      effective: effectiveGrants(grants, pam, breakGlass),
      pam,
      breakGlass,
    };
    next();
  };
}
