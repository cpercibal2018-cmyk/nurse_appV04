// UI-only access helpers derived from /auth/me. They hide navigation and
// buttons a user cannot use; they are NEVER the enforcement point — the backend
// authorizes every request (architecture plan §4).

import { useAuth } from './useAuth';
import type { AppRole, EffectiveRole } from '../types/api';

export function usePermissions() {
  const effectiveRoles = useAuth((s) => s.effectiveRoles);
  const roles = useAuth((s) => s.roles);
  const user = useAuth((s) => s.user);
  return {
    /** Holds one of these roles right now (a dormant System Admin does not count). */
    hasRole: (...wanted: EffectiveRole[]) => effectiveRoles.some((r) => wanted.includes(r)),
    /** Holds an assignment for one of these roles, dormant or not (e.g. to offer PAM elevation). */
    holdsAssignment: (...wanted: AppRole[]) => roles.some((r) => wanted.includes(r.role)),
    /** An account linked to an employee record can use self-service pages. */
    isEmployee: user?.employeeId != null,
  };
}
