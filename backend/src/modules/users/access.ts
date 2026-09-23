// Who is calling and what they may touch, resolved from the database on every
// request (rule R9: a revocation takes effect on the next request; no cache).

import type { AppRole, ScopeType } from '../../generated/prisma/client.js';
import type { DbClient } from '../../lib/prisma.js';
import { PERMISSIONS, type EffectiveRole, type Permission } from './permissions.js';

export interface Grant {
  /** null for the synthetic break-glass grant. */
  id: number | null;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  expiresAt: Date | null;
}

export interface AuthContext {
  user: { id: number; email: string; displayName: string; employeeId: number | null; isBreakGlass: boolean };
  sessionFamily: string;
  csrfHash: string;
  /** Active assignments as stored (not revoked, not expired). */
  grants: Grant[];
  /** Grants usable right now: SYSTEM_ADMIN counts only while elevated (R13) or under break-glass (R18). */
  effective: Grant[];
  pam: { expiresAt: Date } | null;
  breakGlass: { eventId: number; expiresAt: Date } | null;
}

declare global {
  namespace Express {
    interface Locals {
      auth?: AuthContext;
    }
  }
}

/** Synthetic root grant for an active break-glass session (spec §3.6: bypasses PAM and four-eyes). */
const BREAK_GLASS_GRANT: Grant = { id: null, role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM', scopeIds: [], expiresAt: null };

export async function activeGrants(db: DbClient, userId: number, now = new Date()): Promise<Grant[]> {
  return db.roleAssignment.findMany({
    where: { userId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, role: true, scopeType: true, scopeIds: true, expiresAt: true },
    orderBy: { id: 'asc' },
  });
}

export async function activePam(db: DbClient, userId: number, now = new Date()) {
  const pam = await db.privilegedSession.findUnique({ where: { userId } });
  return pam && pam.expiresAt > now ? { expiresAt: pam.expiresAt } : null;
}

export async function activeBreakGlass(db: DbClient, userId: number, now = new Date()) {
  const ev = await db.breakGlassEvent.findFirst({
    where: { actorUserId: userId, endedAt: null, expiresAt: { gt: now } },
    orderBy: { activatedAt: 'desc' },
  });
  return ev ? { eventId: ev.id, expiresAt: ev.expiresAt } : null;
}

export function effectiveGrants(grants: Grant[], pam: AuthContext['pam'], breakGlass: AuthContext['breakGlass']): Grant[] {
  if (breakGlass) return [BREAK_GLASS_GRANT];
  return grants.filter((g) => g.role !== 'SYSTEM_ADMIN' || pam !== null);
}

export function effectiveRoles(auth: AuthContext): EffectiveRole[] {
  return ['EMPLOYEE', ...new Set(auth.effective.map((g) => g.role))];
}

export type PermissionCheck = 'ALLOWED' | 'DENIED' | 'NEEDS_ELEVATION';

export function checkPermission(auth: AuthContext, permission: Permission): PermissionCheck {
  const allowed: readonly EffectiveRole[] = PERMISSIONS[permission];
  if (effectiveRoles(auth).some((r) => allowed.includes(r))) return 'ALLOWED';
  // Holds a dormant SYSTEM_ADMIN assignment that would allow this: tell them to elevate.
  if (allowed.includes('SYSTEM_ADMIN') && auth.grants.some((g) => g.role === 'SYSTEM_ADMIN')) return 'NEEDS_ELEVATION';
  return 'DENIED';
}

/** A resolved record scope: every unit, or an explicit set of unit ids. */
export type UnitScope = { all: true } | { all: false; unitIds: Set<number> };

/**
 * The units the caller may act on through the given roles. DEPARTMENT grants
 * expand to the units of those departments (read fresh). Server-evaluated:
 * an id sent by the browser never establishes access (R15).
 */
export async function unitScope(db: DbClient, auth: AuthContext, roles: readonly AppRole[]): Promise<UnitScope> {
  const grants = auth.effective.filter((g) => roles.includes(g.role));
  if (grants.some((g) => g.scopeType === 'SYSTEM')) return { all: true };
  const unitIds = new Set(grants.filter((g) => g.scopeType === 'UNIT').flatMap((g) => g.scopeIds));
  const deptIds = grants.filter((g) => g.scopeType === 'DEPARTMENT').flatMap((g) => g.scopeIds);
  if (deptIds.length > 0) {
    const units = await db.unit.findMany({ where: { departmentId: { in: deptIds } }, select: { id: true } });
    for (const u of units) unitIds.add(u.id);
  }
  return { all: false, unitIds };
}

export function scopeCovers(scope: UnitScope, unitIds: Iterable<number>): boolean {
  if (scope.all) return true;
  for (const id of unitIds) if (!scope.unitIds.has(id)) return false;
  return true;
}

/** The unit ids a requested grant scope refers to (for coverage checks). */
export async function unitsOfScope(db: DbClient, scopeType: ScopeType, scopeIds: number[]): Promise<number[] | 'ALL'> {
  if (scopeType === 'SYSTEM') return 'ALL';
  if (scopeType === 'UNIT') return scopeIds;
  const units = await db.unit.findMany({ where: { departmentId: { in: scopeIds } }, select: { id: true } });
  return units.map((u) => u.id);
}

/**
 * Rule R8 counter: active System Admin assignments held by ACTIVE accounts,
 * excluding one assignment or one account (the one about to be removed). An
 * assignment on a deactivated account cannot sign in, so it does not count.
 * Callers hold the lock taken by lockSystemAdminChanges.
 */
export async function otherActiveSystemAdmins(db: DbClient, exclude: { assignmentId?: number; userId?: number }, now = new Date()) {
  return db.roleAssignment.count({
    where: {
      role: 'SYSTEM_ADMIN', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      user: { isActive: true },
      ...(exclude.assignmentId ? { id: { not: exclude.assignmentId } } : {}),
      ...(exclude.userId ? { userId: { not: exclude.userId } } : {}),
    },
  });
}

/** Serialises every change that could remove the last System Admin (R8). */
export const lockSystemAdminChanges = (db: DbClient) => db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('role_assignments:revoke'))`;
