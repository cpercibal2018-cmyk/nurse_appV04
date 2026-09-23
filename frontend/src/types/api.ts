// DTO types shared by the frontend. The backend is authoritative; these mirror
// its responses (docs/API_MAP.md) and grow with each domain module.

export type AppRole = 'SYSTEM_ADMIN' | 'HR_ADMIN' | 'SUPERVISOR';
export type ScopeType = 'SYSTEM' | 'DEPARTMENT' | 'UNIT';

export interface RoleGrant {
  id: number | null;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  expiresAt: string | null;
  /** A System Admin assignment that needs PAM elevation before it counts (R13). */
  dormant?: boolean;
}

export interface SessionUser {
  id: number;
  email: string;
  displayName: string;
  /** Set when the account belongs to an employee (self-service). */
  employeeId: number | null;
  isBreakGlass: boolean;
}

export type EffectiveRole = AppRole | 'EMPLOYEE';

/** GET /api/v1/auth/me */
export interface MeResponse {
  user: SessionUser;
  roles: RoleGrant[];
  effectiveRoles: EffectiveRole[];
  pam: { expiresAt: string } | null;
  breakGlass: { expiresAt: string } | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

/** POST /api/v1/auth/login and /refresh */
export interface TokenResponse {
  token: string;
  csrfToken: string;
  expiresIn: number;
}

/** Every API error body: {error: {code, message, details?}} */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** GET /api/v1/health (200 when the database answers, 503 otherwise) */
export interface Health {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
}
