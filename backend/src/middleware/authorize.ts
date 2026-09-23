import type { RequestHandler, Response } from 'express';
import { HttpError, unauthorized } from '../lib/http-errors.js';
import { checkPermission, type AuthContext } from '../modules/users/access.js';
import type { Permission } from '../modules/users/permissions.js';

/**
 * Role gate for a route (default deny, R15). Record scope is then applied by
 * the service, which filters rows by the caller's resolved unit scope.
 */
export function authorize(permission: Permission): RequestHandler {
  return (_req, res, next) => {
    const auth = res.locals.auth;
    if (!auth) return next(unauthorized());
    const result = checkPermission(auth, permission);
    if (result === 'ALLOWED') return next();
    if (result === 'NEEDS_ELEVATION') {
      return next(new HttpError(403, 'PAM_ELEVATION_REQUIRED', 'System Admin rights are dormant — request elevation (PAM) first'));
    }
    next(new HttpError(403, 'FORBIDDEN', 'You do not have permission to do this'));
  };
}

/** The authenticated caller; only valid after `authenticate`. */
export function authOf(res: Response): AuthContext {
  const auth = res.locals.auth;
  if (!auth) throw unauthorized();
  return auth;
}
