// Record scope for credential and eligibility endpoints (spec §8.1
// Credentials row; R15: an id sent by the browser never establishes access).

import { HttpError, notFound } from '../../lib/http-errors.js';
import type { DbClient } from '../../lib/prisma.js';
import { unitScope, type AuthContext, type UnitScope } from '../users/access.js';

export const HR_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;
export const REVIEW_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR'] as const;

export type Viewer = 'OWN' | 'HR' | 'SUPERVISOR';

const outOfScope = () => new HttpError(403, 'SCOPE_NOT_COVERED', 'This employee is outside your assigned scope');

export function inScope(scope: UnitScope, unitId: number | null): boolean {
  return scope.all || (unitId !== null && scope.unitIds.has(unitId));
}

/**
 * How the caller relates to an employee's records: their own, as a scoped
 * HR/System Admin, or as a scoped Supervisor. Throws 403/404 otherwise.
 * `allow` limits which relationships the operation accepts.
 */
export async function viewerOf(db: DbClient, auth: AuthContext, employeeId: number, allow: readonly Viewer[]): Promise<{ viewer: Viewer; unitId: number | null }> {
  const emp = await db.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { unitId: true } });
  if (!emp) throw notFound('Employee not found');
  if (allow.includes('OWN') && auth.user.employeeId === employeeId) return { viewer: 'OWN', unitId: emp.unitId };
  if (allow.includes('HR') && inScope(await unitScope(db, auth, HR_ROLES), emp.unitId)) return { viewer: 'HR', unitId: emp.unitId };
  if (allow.includes('SUPERVISOR') && inScope(await unitScope(db, auth, ['SUPERVISOR']), emp.unitId)) return { viewer: 'SUPERVISOR', unitId: emp.unitId };
  throw outOfScope();
}

/** Prisma filter restricting employees to a unit scope. */
export const employeeInScope = (scope: UnitScope) => (scope.all ? {} : { unitId: { in: [...scope.unitIds] } });
