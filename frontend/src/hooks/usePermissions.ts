// UI-only access helpers derived from /auth/me. They hide navigation and
// buttons a user cannot use; they are NEVER the enforcement point — the backend
// authorizes every request (architecture plan §4).

import { useAuth } from './useAuth';
import type { AppRole } from '../types/api';

export function usePermissions() {
  const roles = useAuth((s) => s.roles);
  const user = useAuth((s) => s.user);
  return {
    hasRole: (...wanted: AppRole[]) => roles.some((r) => wanted.includes(r.role)),
    /** An account linked to an employee record can use self-service pages. */
    isEmployee: user?.employeeId != null,
  };
}
